# LinkedIn post — draft

Fits LinkedIn's 3,000-character limit. Copy everything between the rules.

---

I had a 2015 iMac collecting dust in a closet. It now runs my job search.

Not a metaphor. It's a headless Ubuntu box on wifi, 4 cores, no usable GPU, sitting on a shelf. Every morning it pulls new postings from 141 companies' public job boards, decides which are worth my time, writes a resume tailored to each, fills in the application — and then stops and asks me.

Job hunting is a volume problem wearing a judgment problem's clothing. Thousands of openings, maybe forty worth applying to. Finding those forty by hand is a full-time job, and the tedium pushes you toward mass-applying, which is how a backend resume ends up in a design role's pile.

So I built the tool I wanted.

The architecture is boring on purpose. Postgres, Node, Playwright. Every job is a row with a status column; every stage claims work, does one unit, commits. The box drops wifi constantly, so anything that can't be killed halfway and restarted safely is a design flaw, not an inconvenience.

The AI does less than you'd think. A cheap model scores fit across five dimensions. The resume builder makes zero model calls — every bullet must map to an ID in a facts file I wrote by hand, which turns "write me a resume" into a selection problem instead of a writing problem. It can't invent a job I didn't have, because there's nowhere for an invention to come from.

The two filters doing the most work aren't AI at all. A title check and a location check, in plain code, eliminate more than half of everything before a model sees it. You don't need an LLM to notice that "Corporate Paralegal, EMEA" isn't a backend role in California.

The hard part was never the automation. It was teaching it to refuse.

An application can't be unsent, so the submitter has eight fail-closed guards. Building them taught me more than the rest of the project:

→ Its pre-flight check passed on a page that had no form on it. "No required field is empty" is trivially true when there are no fields.

→ It once prepared to attach a resume tailored for a completely different company. Every guard passed. Nothing verified the document matched the job.

→ It scored a UK role as a strong match while its own notes read "hard blocker: UK residency required." The code treated a dealbreaker as a rounding error.

Each of those looked like it worked. Each was caught by checking against reality instead of trusting the check.

It hasn't sent a single application yet. Not because it can't — because it won't send one it can't prove is complete. I'd rather it apply to five jobs correctly than five hundred badly. That constraint made it better than any feature I could have added.

13,748 jobs indexed. 141 companies. Half eliminated before spending a cent. An old iMac earning its keep.

If you're an engineer sitting on an annoying problem and an old computer — that's a project.

(Backend / AI / forward-deployed roles, US. Always happy to talk shop about brittle web automation and fail-closed systems.)

---

## Notes

**Length:** 2,977 characters — 23 under LinkedIn's 3,000 limit. If you edit, re-check; it's tight.

**What I cut to fit (654 chars):** the "I'm a software engineer looking for my next role" line (the closing signal already says it), the second half of the guard-failure bullets, "the thing engineers do," and the "most useful thing I've built lately" sentence. The three failure stories survived intact — they're the strongest part.

**Shorter hook, if you want a punchier open:**
> The best thing my job-hunting agent does is refuse to apply.

Swapping that in as the first line adds ~60 chars, so drop the "(Backend / AI...)" sign-off or trim a bullet to stay under.

**Why this framing:** the post is itself a hiring signal, so it leads with judgment rather than "look, I used AI." The failures show debugging instinct and respect for irreversible actions — what a hiring manager is actually screening for. "Applied to 500 jobs automatically" reads as spam; "won't send what it can't verify" reads as maturity.

**Every number is real:** 141 companies, 13,748 jobs, 8 guards, 5 scoring dimensions, zero submissions so far.

**Two things to decide before posting:**
- The closing line is an explicit "open to work" signal. Cut it if you're posting while employed.
- Some recruiters dislike automated applications on principle. The human-approval gate is a genuine defence, so keep it prominent. If you'd rather not signal automation at all, reframe around "a tool that reads 13,748 job descriptions so I can spend attention on the forty that matter."
- If you post after the first application actually goes out, the "hasn't sent a single application" line needs rewriting — it's the pivot of the whole piece.
