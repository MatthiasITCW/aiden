# Product Hunt Launch Playbook (June 8)

Date: 2026-05-06  
Source attribution: Hermes Agent v0.12.0, gpt-5.3-codex via ChatGPT Plus OAuth, this WSL session  
Purpose: Primary-source reference doc for Aiden v4.0 launch and v4.1 roadmap

## A) Product Hunt launch copy

### Tagline options (pick one)
1) Aiden: a Windows-native agentic CLI that actually shows its work.
2) Aiden is your honest AI terminal agent for real work on Windows.
3) Aiden: production-grade agentic CLI with verifiable actions and safety rails.

### Short description
Aiden is a Windows-native TypeScript agentic CLI built for real production workflows, not demos. It can run tools, edit code, automate tasks, and recover from model/provider failures. Every action is traceable, safety-guarded, and designed to be verifiable.

### Maker comment (long-form)
Hey Product Hunt — I’m Shiva, maker of Aiden.

I built Aiden after seeing too many “impressive” AI agents fail in real workflows: they sounded smart, but you couldn’t trust execution.

Aiden focuses on the boring hard stuff:
- Verifiable actions (paths/IDs/status, not vague claims)
- Strong safety rails with practical approvals
- Provider/model fallback when APIs fail
- Native Windows-first UX (not an afterthought)
- Persistent memory + skills for repeat workflows

What Aiden is not:
- Not magic
- Not perfect
- Not “autonomous” at all costs

What it is:
- A pragmatic, production-minded CLI agent that tries to earn trust turn by turn.

If you try it, I’d love brutally honest feedback:
1) Where did trust break?
2) Where was setup confusing?
3) What would make you use it daily?

### Launch CTA
Try one real task (not a toy prompt), then tell us where it failed. That feedback is gold.

## B) Brutally honest FAQ

Q1) Is Aiden fully autonomous?  
No. It’s tool-using and proactive, but bounded by safety, approvals, and your environment permissions.

Q2) Can it still hallucinate?  
Yes. Any LLM can. We reduce this with runtime checks, tool-trace validation, and verification-first workflows.

Q3) Why does it sometimes ask for approval?  
Because dangerous commands should not run silently. We optimize to reduce prompt fatigue while keeping a hard safety floor.

Q4) Why is first response sometimes slower than ChatGPT?  
Because Aiden is executing, validating, and often coordinating tools — not just generating text.

Q5) Why not just use one fixed model?  
Provider/model behavior changes. Aiden is built to tolerate churn and recover with fallback paths.

Q6) Is this just for developers?  
Primary audience is technical users, but anyone with structured workflows can benefit. Best fit today: devs, ops, power users.

Q7) What can go wrong?  
Auth setup friction, provider outages, edge-case tool-call regressions, or environment-specific command behavior.

Q8) What are known limitations today?  
[List your real top 3–5 launch-day limitations explicitly.]

Q9) What data does Aiden store?  
[Your exact policy.] Be explicit about sessions, logs, memory, telemetry, and opt-outs.

Q10) Why should I trust it?  
Don’t trust claims — trust verifiability. Aiden should provide inspectable outcomes for what it did.

## C) Day-0 support playbook

### Mission (first 72 hours)
- Fast response
- Honest triage
- Publicly visible fixes
- No defensive messaging

### Support channels
- PH comments (public)
- GitHub Issues (structured bugs)
- Discord/Telegram (quick help)
- Single pinned “Known Issues” thread

### SLA targets
- First response: < 30 min during launch window
- Triage label: < 2 hours
- Critical bug workaround: < 4 hours
- Hotfix or rollback decision: < 8 hours

### Severity rubric
- Sev0: data loss/security bypass/unsafe exec
- Sev1: install/setup blocker or widespread crash
- Sev2: degraded UX with workaround
- Sev3: minor bug/docs issue

### Day-0 triage intake template
Ask every reporter:
1) OS + shell + Aiden version
2) Provider/model in use
3) Exact command/prompt used
4) Expected vs actual behavior
5) Logs/error snippet
6) Reproducible? (Y/N)

### Response templates

Install failure  
“Thanks — this is on us to make easier. Please run [diagnostic command], paste output, and we’ll guide you step-by-step. If blocked now, use this 2-minute fallback path: [path].”

False completion report  
“Thank you. This is a high-priority trust bug. Please share the session trace ID and expected output artifact. We’ll reproduce and patch before suggesting workarounds.”

Provider outage/regression  
“You’re right — provider regression detected. Temporary workaround: switch to [provider/model]. We’re shipping adapter fix and will post status in [issue link].”

### Known-issues board format
- Issue
- Scope (who affected)
- Workaround
- Fix ETA
- Status (Investigating / Patch in review / Released)

### Launch day staffing
- 1 triage lead
- 1 runtime/adapter engineer
- 1 onboarding/docs engineer
- 1 community responder
(If solo: rotate by hour and publish slower-but-clear SLA)

### Postmortem cadence
- 24h: top 10 issues + fixes + open risks
- 72h: retention-impact analysis + roadmap changes

## D) What to pin publicly on launch day

Pin message:
“Try Aiden on one real task. If it fails, report it with repro details here: [link]. We prioritize trust bugs (false completion, unsafe behavior, setup blockers) over feature requests this week.”

That single sentence signals maturity.
