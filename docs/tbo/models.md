# Models: which AI does which job

TASK-2026-00012. TBO Support (the `helpdesk` app) and the TBO Copilot worker share one rule: every job runs on
**GPT-5.6 Luna** (`gpt-5.6-luna`, OpenAI) for every job. **Kimi** (`kimi-k2.6`, Moonshot) was the fallback; since
28 Oct 2026 it gets no customer data, so the fallback is off (see Data terms). A job that
needs another model gets its own row; nothing else changes.

## Where it is set

TBO Support → **Settings → AI providers**:

- **OpenAI** and **Anthropic-compatible** sections: each with its model, address and key. Luna is in the OpenAI
  section, Kimi in the Anthropic-compatible one (`https://api.moonshot.ai/anthropic`), which has had no key since
  28 Oct 2026 (see Data terms).
- **Primary provider** and **Fall back to the other provider**: the order, for every job.
- **Models per job**: one optional row per job, with its own model in either section. Blank uses the section's
  model, so with no rows every job uses the primary section, and the other one only when the fallback is on. A
  change applies from the job's next call, with no deploy. Since 28 Oct 2026 that is OpenAI alone; a row with a Kimi
  model would send that job's customer data to Moonshot, so none is added while the Data terms decision stands.

| Job | What it does | Where it runs |
|---|---|---|
| `triage` | The first look at a new ticket | TBO Support |
| `draft` | Reply suggestions, knowledge base drafts, content | TBO Support |
| `summary` | Home plan, team dashboards, work summaries, repeat issues | TBO Support |
| `task` | Task descriptions and estimates | TBO Support |
| `chat` | The chatbot of a later phase (only a row for now) | TBO Support |
| `investigate` | Finding a ticket's root cause | The worker |
| `fix` | Writing and testing the fix | The worker |
| `review` | Reviewing the fix before a person approves it | The worker |

The details of the hub side (failover, pauses, alerts, usage log) are in the `helpdesk` repository's
`docs/ai-providers.md`.

## The worker

The worker holds its own keys, in its settings file; TBO Support sends it only, for each of its jobs, the sections
in order with the model and the price per million tokens (`run_context.models`). A key therefore only goes to an
address the worker's own file names, and a section the worker has no key for is never used.

| Setting | For |
|---|---|
| `TBO_PROVIDER_OPENAI_API_KEY` | TBO Support's OpenAI section. Address `https://api.openai.com/v1`, API format OpenAI Responses (GPT-5.6 refuses tools with reasoning through Chat Completions) |
| `TBO_PROVIDER_MOONSHOT_API_KEY` | TBO Support's Anthropic-compatible section (Kimi). Address `https://api.moonshot.ai/v1`, Chat Completions. Not set since 28 Oct 2026 (see Data terms) |
| `TBO_PROVIDER_<OPENAI or MOONSHOT>_BASE_URL`, `_API_STYLE` | Only to change those defaults |
| `TBO_PROVIDER_<OPENAI or MOONSHOT>_IMAGES` | Whether the model reads pictures: on for OpenAI, off for Moonshot unless set to `1` |
| `TBO_MODEL_*` | The older single model for every stage; used when TBO Support names no model the worker has a key for. Without `TBO_MODEL_BASE_URL` and `TBO_MODEL_ID` it is Kimi (`https://api.moonshot.ai/v1`, `kimi-k2.6`), and a bare `MOONSHOT_API_KEY` counts as its key, so while the Data terms decision stands both are set to OpenAI and no Moonshot setting is present |

- **Each stage on its own model:** the investigation, the fix and the review each take their job's main model.
- **Fallback:** when a turn fails on a key, billing or quota, a wrong model, a server error, the network or a
  timeout, that stage starts again once on the fallback model, in a fresh session (a fix's fresh session is told to
  read the edits already made). A request the provider refuses as invalid is not retried elsewhere. If the fallback
  fails too, the run fails and TBO Support hands it to a person, as before.
- **Cost:** the run budget counts each stage and model apart. The report to TBO Support carries one entry per stage
  and model, and TBO Support logs each as a usage row with the run and its ticket, so a ticket's whole AI cost is in
  one report.

## Data terms (checked 17 Oct 2026)

What the providers' own pages say about the data we send. Read them again before a change of plan or provider.

**OpenAI** ([Your data](https://developers.openai.com/api/docs/guides/your-data)):
- API data is not used to train OpenAI's models unless the organisation opts in.
- Abuse-monitoring logs of requests and answers are kept up to 30 days, for Chat Completions and Responses alike
  (longer only where the law requires it).
- No application state is stored for Chat Completions (TBO Support uses it). The Responses API keeps responses for
  30 days unless the request says `store: false`; the worker's engine sends `store: false`.
- Zero Data Retention (no abuse-monitoring logs) needs OpenAI's approval, through their sales team.

**Moonshot (Kimi)** ([Terms of service](https://platform.kimi.ai/docs/agreement/modeluse), updated 30 Jul 2026;
[Privacy policy](https://platform.kimi.ai/docs/agreement/userprivacy), updated 30 Apr 2025):
- The customer owns its inputs and outputs, which are treated as its confidential information.
- **Moonshot may use the content to develop and improve its services, which includes training, unless agreed
  otherwise in writing.** A restriction can be requested (an enterprise or written arrangement).
- No fixed retention period: content is kept while the account is active and deleted after termination.
- Data is stored on servers in Singapore; the company is Moonshot AI Pte. Ltd., Singapore law.
- The customer is responsible for the personal data it sends (notices and consents).

So: before tickets with customer ERP data go to Kimi, TBO either obtains Moonshot's written restriction on training,
or keeps Kimi to jobs without customer data (a row in Models per job), or leaves the fallback off.

**Decision (28 Oct 2026): the fallback is off.** No customer data goes to Kimi:

- On the hubs, **Fall back to the other provider** is off, and the Anthropic-compatible section has no key.
- The worker has no `TBO_PROVIDER_MOONSHOT_API_KEY` and no `MOONSHOT_API_KEY`. Its older single model, which a stage falls back to when TBO Support names no model the worker has a key for, is OpenAI too: `TBO_MODEL_BASE_URL=https://api.openai.com/v1`, `TBO_MODEL_ID=gpt-5.6-luna`, `TBO_MODEL_API_STYLE=responses`. It must not be left on its defaults, which are Kimi (checked on the worker server on 28 Oct 2026).

Every job runs on OpenAI, and nothing moves to Kimi when OpenAI fails:

- TBO Support's own AI features (triage, suggested replies) stop, and TBO Support sends its alert that no other
  provider is set up.
- A Copilot investigation that cannot reach a model ends as Failed. The customer sees "With our team", and the people
  following the ticket are told.
- A fix that fails is marked Failed on the ticket, and a person can start it again.

Kimi comes back as the fallback only after Moonshot restricts training in writing. Kimi may still review TBO's own
code, which holds no customer data.

## The desktop app

Each person uses their own OpenAI key, never a shared one:

1. **Settings → AI providers → Add provider → OpenAI.**
2. Paste your **API key**, then **Test connection**: it lists your models. Keep the **API format** at
   **OpenAI Responses** (the OpenAI default).
3. Save. In **Manage models**, keep `gpt-5.6-luna` turned on.
4. **Settings → Models → Default model:** `gpt-5.6-luna`, or pick it per conversation.

## Measuring a model

Before a model takes a job, it runs on the evaluation cases with the worker's `eval` command
(`apps/tbo-worker/README.md`): right root cause, fix files found, time and cost per case, compared with the model it
would replace. Each case's result stays in the private repository; this page gets only the totals and the kinds of
job the model finds hard.

### GPT-5.6 Luna against Kimi K2.6 (investigation, 17 Oct 2026)

The same 10 evaluation cases (7 bugs, 3 customization requests from one pilot customer's apps, with no live site
connected), investigated by the worker: Luna on 17 Oct, Kimi on 12 Oct.

| Measure | GPT-5.6 Luna | Kimi K2.6 |
|---|---|---|
| Bugs: root cause right | 5 of 7 | 5 of 7 (the same two missed) |
| Customization requests not called a defect | 3 of 3 | 3 of 3 |
| Fix files named | 13 of 23 | 14 of 23 |
| Median minutes per case | 0.3 | 5.6 |
| Median tokens per case | 62,000 | 357,000 |
| Share of input served from the provider's cache | 60% | 86% (16 cases) |
| Cost of the 10 cases | $0.11 (at $0.20 / $1.20 per million, $0.02 cached) | not priced in that run |

- **Accuracy is the same, time and tokens are not:** Luna sends several tool calls per request, so it needs far
  fewer requests; each case took well under a minute.
- **What both find hard:** the two missed bugs have their cause outside the custom app's code (a standard ERPNext
  report and a sales-return default), and with no live site connected neither model could check the site; both
  answered "unclear" with the questions to ask, rather than guessing. A connected site (error logs, customizations,
  version history) is the next thing to measure.
- **Counting fixed on the way:** OpenAI's Responses API reports the input it writes to its cache apart from the
  other input; the worker now counts it, which the first Luna run did not (it showed about a third of the real cost).
