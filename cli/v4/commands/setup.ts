/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/setup.ts — Phase 30.2.1
 *
 * `/setup` — re-runs the setup wizard from inside an existing REPL
 * session. Most useful in explore mode (after the boot wizard's
 * "Skip — explore Aiden first" branch) where the user has decided
 * they want to actually configure a provider after looking around.
 *
 * After the wizard returns, we tell the user to restart Aiden so
 * the new provider/model is picked up — hot-swapping the provider
 * adapter inside an in-flight session is v4.1 territory and would
 * require rebuilding the AidenAgent's provider field, the fallback
 * chain, and the chatSession's currentProviderId in lockstep.
 */
import type { SlashCommand } from '../commandRegistry';
import { runSetupWizard } from '../setupWizard';

export const setup: SlashCommand = {
  name: 'setup',
  description: 'Re-run the setup wizard (configure provider + API key).',
  category: 'system',
  icon: '⚙',
  handler: async (ctx) => {
    if (!ctx.paths) {
      ctx.display.printError(
        'Cannot run wizard from this context — no paths available.',
        'This is a wiring bug; please report.',
      );
      return;
    }
    const result = await runSetupWizard({
      paths: ctx.paths,
      display: ctx.display,
      force: true,
    });
    if (result.status === 'configured' && result.ran) {
      ctx.display.write(
        '\nProvider configured. ' +
          'Restart Aiden (`/quit` then re-run `aiden`) to pick up the new provider.\n\n',
      );
    } else if (result.status === 'skipped') {
      ctx.display.write(
        '\nStill in explore mode. Run /setup again whenever you\'re ready.\n\n',
      );
    } else if (result.status === 'exited') {
      // Wizard explicitly chose to exit — but we're inside a REPL,
      // so just report and stay in the session.
      ctx.display.dim('Wizard exited; continuing existing session.');
    }
    return;
  },
};
