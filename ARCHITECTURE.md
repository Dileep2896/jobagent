# jobagent — architecture

An unattended job-application pipeline. It discovers postings from public ATS
APIs, scores them against a hand-written facts file, builds a tailored resume,
fills the employer's form, and stops at a human approval gate.

It runs on a 2015 iMac: headless Ubuntu 24.04, 4-core Skylake i5, no usable GPU,
wifi only. **That constraint shapes every decision below** — the box drops its
connection regularly, so any stage that cannot be killed mid-run and restarted
safely is a design flaw, not an inconvenience.

---

## Pipeline

```mermaid
flowchart TD
    A["discover.js<br/><i>public ATS APIs</i>"] --> B{"pre-filter<br/><b>free, no model</b>"}
    B -->|"title or location<br/>disqualifies"| X["filtered_out"]
    B -->|survives| C["filter.js<br/><i>Haiku 4.5, 5-dimension rubric</i>"]
    C -->|"score &lt; 3.5<br/>or hard blocker"| X
    C -->|"score ≥ 3.5"| D["shortlisted"]

    D --> E["generate.js<br/><i>no model calls</i>"]
    E --> F["drive-upload.js<br/><i>PDF → Google Drive</i>"]
    F --> G["prefill.js<br/><i>Playwright, fills form</i>"]
    G --> H["ready_for_review"]

    H --> I{"pre-flight audit<br/><b>8 fail-closed guards</b>"}
    I -->|"any guard fails"| J["stays for the human<br/><i>blocker named in the sheet</i>"]
    I -->|"all pass + --confirm"| K["submit.js"]
    K --> L{"confirmation<br/>page seen?"}
    L -->|no| J
    L -->|yes| M["applied"]

    M --> N["sheets-sync.js"]
    J --> N
    N --> O["notify.js → Discord"]

    style B fill:#1b5e20,color:#fff
    style I fill:#b71c1c,color:#fff
    style X fill:#424242,color:#fff
    style M fill:#0d47a1,color:#fff
```

Every stage claims work, does **one unit**, commits, and moves on. A crash loses
at most the in-flight item, never a written verdict.

---

## Job status machine

`status` on the `jobs` table is the resumability spine. Each stage claims rows in
one status and commits them into the next.

```mermaid
stateDiagram-v2
    [*] --> new: discover.js
    new --> filtering: claimed<br/>(FOR UPDATE SKIP LOCKED)
    filtering --> new: crash / stale claim<br/>swept after 30 min
    filtering --> shortlisted: score ≥ 3.5
    filtering --> filtered_out: score &lt; 3.5, or<br/>a stated hard blocker
    filtering --> filter_failed: errored MAX_ATTEMPTS times

    shortlisted --> generating: generate.js claims
    generating --> shortlisted: build failed,<br/>resume_attempts + 1
    generating --> ready_for_review: resume built

    shortlisted --> ready_for_review: prefill.js<br/>(the path run-daily.sh uses)

    ready_for_review --> applied: submit.js,<br/>confirmation page verified
    applied --> interview
    applied --> rejected
    new --> stale: posting disappeared

    filtered_out --> [*]
    filter_failed --> [*]
```

> **Note:** `generate.js` has a pipeline mode that lands jobs directly on
> `ready_for_review`, but `run-daily.sh` deliberately does **not** use it —
> `prefill.js` owns that transition. Swapping them would silently skip form
> prefill and ask the human to review forms nobody filled.

---

## Cost control

The expensive stage is the model filter. Three layers sit in front of it, applied
in order:

```mermaid
flowchart LR
    A["13,748 jobs"] --> B["title pre-filter<br/><b>free</b>"]
    B --> C["location pre-filter<br/><b>free</b>"]
    C --> D["Message Batches API<br/><b>half price</b>"]
    D --> E["verdict"]

    B -.->|"Counsel, Recruiter,<br/>Paralegal, Sales"| X1["dropped"]
    C -.->|"non-US with no<br/>US or remote-US signal"| X2["dropped"]

    style B fill:#1b5e20,color:#fff
    style C fill:#1b5e20,color:#fff
    style D fill:#e65100,color:#fff
```

The two free filters eliminate **more than half the corpus** before a model sees
anything. Both derive from the candidate's own `targets` block — a Bengaluru
posting is a rejection the facts file already implies, and paying ~2,700 tokens
to restate it is waste.

Both fail **open**: a job is dropped only on an unambiguous signal. A false
negative here is a job silently never applied to, which is worse than a wasted
call.

**Not used:** prompt caching (the system prompt is ~860 tokens against Haiku's
4,096-token minimum cacheable prefix — a breakpoint would be a silent no-op), and
local inference (an 8B model on this CPU runs ~2–3 min/job, ~30 hours for the
backlog, on the same 4 cores `pdflatex` needs).

---

## Resume generation — no model calls

```mermaid
flowchart TD
    A["master-facts.json<br/><i>hand-written, gitignored</i>"] --> B["score each fact<br/>against the JD"]
    B --> C["select top N<br/><i>selection, not writing</i>"]
    C --> D["render LaTeX"]
    D --> E["pdflatex"]
    E --> F{"gates"}
    F -->|fail| G["shrink or grow<br/>content, retry"]
    G --> D
    F -->|pass| H["PDF + .docx"]

    style A fill:#1b5e20,color:#fff
    style F fill:#b71c1c,color:#fff
```

Every bullet must map to an `id` in `master-facts.json`. That turns "write me a
resume" into a **selection problem**, so nothing can be invented — there is
nowhere for an invention to come from.

Gates, all mechanical, all run against the compiled PDF:

| Gate | Check |
|---|---|
| Fact coverage | every selected fact's text survives into the PDF |
| ATS parse | contact details survive `pdftotext` |
| Section headings | extract contiguously (`SUMMARY`, not `S UMMARY`) |
| Page count | exactly one |
| Overfull hbox | none — catches text run off the margin |
| JD keyword coverage | ≥ 70% of owned terms the posting names |
| Page fill | ghostscript bbox — bottom ink within ~10pt of the margin |

---

## The submit guards

`submit.js` is the only script that does something irreversible. Eight
fail-closed guards, in order:

```mermaid
flowchart TD
    G1["1. status = ready_for_review"] --> G2["2. unexpired, unconsumed approval"]
    G2 --> G3["3. resume unchanged since approval"]
    G3 --> G4["4. not already applied"]
    G4 --> G5["5. no required field left empty"]
    G5 --> G6["6. a form was actually found<br/><i>resume accepted + ≥3 fields filled</i>"]
    G6 --> G7["7. resume belongs to THIS job<br/><i>deterministic filename</i>"]
    G7 --> G8["8. resume STILL attached at the click"]
    G8 --> S["click submit"]
    S --> V{"confirmation page?"}
    V -->|no| R["do NOT record applied"]
    V -->|yes| A["applied"]

    style G6 fill:#b71c1c,color:#fff
    style G7 fill:#b71c1c,color:#fff
    style G8 fill:#b71c1c,color:#fff
```

Guards 6, 7 and 8 exist because of real failures, and each is the same lesson:
**evidence that was true when gathered, and not when it mattered.**

- **Guard 6** — the audit passed on a page with *no form on it*. "No required
  field is empty" is trivially true when there are no fields. Greenhouse was
  302-redirecting to a job description page.
- **Guard 7** — a resume tailored for a different company was about to be
  attached. Every other guard passed; nothing verified the document matched
  the job.
- **Guard 8** — the resume was attached during filling and gone by the click.
  Greenhouse uploads to S3 asynchronously and tracks the file in JS state, not
  the DOM, so `setInputFiles` resolving proved nothing.

`--auto` replaces **guard 2 only**. The audit becomes the approver, an approval
row is still written as `approved_by='auto'`, and everything else stands.

---

## Board support

| Board | Discovery | Resume | Prefill | Auto-submit |
|---|---|---|---|---|
| **Greenhouse** | ✅ | ✅ | ✅ | ✅ 2/3 dry runs passed |
| **Lever** | ✅ | ✅ | ⚠️ partial | ❌ 0/3 |
| **Ashby** | ✅ | ✅ | ⚠️ partial | ❌ 0/3 |

- **Greenhouse** must use the `/embed/job_app` endpoint. The obvious board URL
  302-redirects to the employer's own careers page, which has no form.
- **Lever**'s "Current location" is a geocoded autocomplete: the visible input is
  cosmetic and the real value lives in a hidden `selectedLocation` field set only
  by clicking a suggestion, which never renders headless.
- **Ashby** asks free-text essay questions ("describe your proudest Android
  feature"). Those cannot be automated without inventing content, which the
  never-invent rule forbids. They pause for the human by design.

Anything the agent cannot submit still gets a tailored resume, a Drive link, and
a tracking-sheet row marked **`YOU — apply by hand`** with the exact blocking
question named.

---

## Data model

```mermaid
erDiagram
    companies ||--o{ jobs : "polls"
    jobs ||--o| approvals : "one per job"
    jobs ||--o{ notifications : "per scenario"

    companies {
        text name
        text board "greenhouse|lever|ashby"
        text board_token
        bool active
    }
    jobs {
        text status "the resumability spine"
        numeric filter_score "computed in code, not by the model"
        jsonb filter_scores "per-dimension breakdown"
        text resume_path
        text resume_drive_url
        text submit_blocker "why the human must finish it"
        timestamptz applied_at "set only on a verified submission"
    }
    approvals {
        text approved_by "human | auto"
        timestamptz expires_at "24h"
        timestamptz consumed_at "single use"
    }
```

Postgres is the source of truth. The tracking sheet and Discord are views.

---

## Hard rules

These are non-negotiable and encoded in the code, not just documented:

1. **Never invent resume content.** Every bullet maps to a fact id.
2. **Never submit without approval.** The pipeline prepares everything and stops.
3. **Screening questions are legal attestations.** Answered once by the human in
   `master-facts.json`, reused verbatim, never inferred. A US work-authorisation
   answer is never given to a question about another country.
4. **Deterministic gates alongside any model score.** LLM-score-only loops
   converge on keyword stuffing.
5. **Everything idempotent and resumable.** The box drops wifi.
6. **Public board APIs only.** Respect robots.txt and ToS.

---

## Running it

```bash
psql -d jobagent -f schema.sql          # idempotent
psql -d jobagent -f companies-seed.sql  # 141 companies
cp master-facts.example.json master-facts.json   # then fill it in
node validate-facts.js

set -a; . ./.env; set +a
node filter.js --prefilter-only              # free, no API calls
node filter.js --limit 300 --batch --board greenhouse --spread
./run-daily.sh                                # full pass, no submissions
AUTO_SUBMIT=1 ./run-daily.sh                  # sends real applications
```

`--spread` round-robins the claim across companies. Without it, a capped run on a
141-company watchlist spends the whole budget on whichever company sits at the
front of the id ordering.
