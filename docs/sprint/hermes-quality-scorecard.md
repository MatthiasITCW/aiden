# Aiden Quality Scorecard (12 Metrics)

Date: 2026-05-06  
Source attribution: Hermes Agent v0.12.0, gpt-5.3-codex via ChatGPT Plus OAuth, this WSL session  
Purpose: Primary-source reference doc for Aiden v4.0 launch and v4.1 roadmap

Use this weekly from now to launch, then daily for launch week.

## Scoring
- Pass = meets threshold
- Warn = close, monitor
- Fail = below threshold, blocks confidence

Recommended rule:
- Launch-ready = no Fail in P0 metrics, <=2 Warn total.

## P0 metrics (must pass)

1) First Task Success Rate (FTSR)
- Definition: % of new sessions where user’s first meaningful request completes without manual recovery.
- Target: Pass >= 75%, Warn 65–74%, Fail < 65%
- Why: onboarding retention hinge.

2) Verifiable Side-Effect Rate
- Definition: % of side-effect actions (file write, API call, command) returning verifiable receipt (path/URL/ID/status).
- Target: Pass >= 98%, Warn 95–97%, Fail < 95%
- Why: trust-per-turn.

3) False Completion Rate
- Definition: % of runs marked “done” where audit shows incomplete/missing output.
- Target: Pass <= 1.0%, Warn 1.1–2.0%, Fail > 2.0%
- Why: fastest trust-killer.

4) Tool-Call Integrity Rate
- Definition: % of model tool intents that become valid executable calls (no malformed/unknown tool fail).
- Target: Pass >= 99%, Warn 97–98.9%, Fail < 97%
- Why: core runtime reliability.

5) P95 End-to-End Turn Latency (interactive)
- Definition: user message -> final answer/tool outcome.
- Target: Pass <= 12s, Warn 13–20s, Fail > 20s
- Why: perceived “agent quality.”

6) Crash-Free Session Rate
- Definition: sessions without agent crash/restart.
- Target: Pass >= 99.5%, Warn 99.0–99.49%, Fail < 99.0%
- Why: operational baseline.

## P1 metrics (high priority)

7) Approval Fatigue Rate
- Definition: % of sessions with >=3 approval prompts in first 10 turns.
- Target: Pass <= 10%, Warn 11–20%, Fail > 20%
- Why: safety UX friction.

8) Dangerous-Action Containment
- Definition: hardline forbidden actions bypassed (count).
- Target: Pass = 0 always, Fail = >=1
- Why: existential safety metric.

9) Provider Fallback Success Rate
- Definition: % of provider-primary failures recovered by fallback without user intervention.
- Target: Pass >= 85%, Warn 70–84%, Fail < 70%
- Why: model churn resilience.

10) OAuth Setup Completion Rate
- Definition: % users starting auth flow who complete and run first successful task.
- Target: Pass >= 80%, Warn 65–79%, Fail < 65%
- Why: onboarding drop-off hotspot.

## P2 metrics (product quality)

11) D2 Return Rate (early cohort)
- Definition: % users active day-0 returning day-2.
- Target: Pass >= 35%, Warn 25–34%, Fail < 25%
- Why: early retention signal.

12) Support Tickets per 100 New Users (first 7 days)
- Definition: support load normalized.
- Target: Pass <= 12, Warn 13–20, Fail > 20
- Why: operational burden, docs/default quality.

## Weekly review template (copy/paste)

AIDEN WEEKLY QUALITY REVIEW  
Week of: ____  
Owner: ____  
Builds included: ____

A) Scorecard snapshot
- P0 Pass/Warn/Fail: __ / __ / __
- P1 Pass/Warn/Fail: __ / __ / __
- P2 Pass/Warn/Fail: __ / __ / __
- Launch gate status: GREEN / YELLOW / RED

B) Metric table
1. FTSR: ____ (threshold >=75) [Pass/Warn/Fail]
2. Verifiable side-effect rate: ____ (>=98)
3. False completion rate: ____ (<=1.0)
4. Tool-call integrity: ____ (>=99)
5. P95 latency: ____ (<=12s)
6. Crash-free sessions: ____ (>=99.5)
7. Approval fatigue: ____ (<=10)
8. Hardline bypass count: ____ (=0)
9. Fallback recovery: ____ (>=85)
10. OAuth completion: ____ (>=80)
11. D2 return: ____ (>=35)
12. Tickets/100 users: ____ (<=12)

C) Top 3 regressions this week
- Regression #1:
  - Symptom:
  - Root cause:
  - Fix:
  - Owner:
  - ETA:
- Regression #2:
- Regression #3:

D) Top 3 wins this week
- Win #1 (metric impact):
- Win #2:
- Win #3:

E) Launch risk log (brutal)
- What could still sink launch?
1.
2.
3.

F) Next-week priorities (max 5)
1.
2.
3.
4.
5.
