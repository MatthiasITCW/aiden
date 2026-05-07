/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/modelPicker.ts — Phase 22 Group B Task 3.
 *
 * Two-step interactive provider/model picker. Powers both `aiden model`
 * and `/model` with no args.
 *
 * Stage 1 (Provider): `⚙ Model Picker — Select Provider`
 *   • Each row shows `<name> (N models) <auth-badge> <tier-badge>`
 *   • Hint line above shows `Current: <provider> on <model>` when known
 *   • Unauthed providers stay selectable but render with ⚠ — selecting
 *     one logs a remediation hint via the caller (model.ts)
 *
 * Stage 2 (Model): `⚙ Model Picker — <provider>`
 *   • Lists the provider's models with `(K)K ctx` + pricing
 *   • Recommended model (ModelEntry.isDefault) marked with ⭐
 *   • `← Back` returns to stage 1 (loops); `Cancel` returns null
 *
 * `spec` short-circuits both stages via Phase 5's ModelSwitcher parser.
 */

import type { RuntimeResolver } from '../../../providers/v4/runtimeResolver';
import { ModelSwitcher } from '../../../providers/v4/modelSwitch';
import {
  PROVIDER_REGISTRY,
  type ProviderRegistryEntry,
} from '../../../providers/v4/registry';
import { listModelsForProvider } from '../../../providers/v4/modelCatalog';

export type ProviderTier = 'pro' | 'free' | 'paid' | 'local' | 'subscription';

export interface ModelPickerOptions {
  resolver: RuntimeResolver;
  /** Bypass the interactive prompts when set. */
  spec?: string;
  /** Restrict provider list to this tier. */
  tier?: ProviderTier;
  /** Injectable prompt module (for tests). */
  promptModule?: PickerPrompts;
  /**
   * Currently active provider/model — surfaced in the stage-1 hint
   * line and used to mark the active provider with `← current`.
   */
  currentProviderId?: string;
  currentModelId?: string;
  /**
   * Auth-state probe (Phase 22 Task 3). Called per provider id at
   * stage-1 render time. Returns true when credentials are present.
   * Caller wires this up using whatever signals are available
   * (env-var presence, OAuth token file, ollama probe). Defaults to
   * "everyone is authed" when omitted, which keeps existing tests
   * and the `aiden model` CLI path working without extra plumbing.
   */
  isProviderAuthed?: (providerId: string) => boolean;
}

export interface PickerPrompts {
  select(opts: {
    message: string;
    choices: { name: string; value: string; description?: string }[];
  }): Promise<string>;
}

const TIER_BADGE: Record<string, string> = {
  pro: '⭐ Pro',
  free: '🆓 Free',
  paid: '💲 Paid',
  local: '🏠 Local',
  subscription: '🔑 Subscription',
};

const BACK_VALUE = '__back__';
const CANCEL_VALUE = '__cancel__';

/** Auth badge rendered into stage-1 provider rows. */
function authBadge(entry: ProviderRegistryEntry, authed: boolean): string {
  if (authed) {
    // OAuth providers note that authed-state means a stored token, not
    // an env-var key — useful for users debugging "where did my creds
    // come from".
    return entry.oauth ? '✓ authed (OAuth)' : '✓ authed';
  }
  if (entry.tier === 'local') return '⚠ no daemon';
  if (entry.oauth) return '⚠ not signed in';
  return '⚠ no API key';
}

/** Map a provider entry to a stage-1 picker row. */
function providerChoice(
  entry: ProviderRegistryEntry,
  modelCount: number,
  authed: boolean,
  isCurrent: boolean,
): { name: string; value: string; description?: string } {
  const badge = TIER_BADGE[entry.tier] ?? entry.tier;
  const ab = authBadge(entry, authed);
  const count = `(${modelCount} model${modelCount === 1 ? '' : 's'})`;
  const current = isCurrent ? '  ← current' : '';
  return {
    name: `${entry.displayName.padEnd(28)} ${count.padEnd(11)} ${ab.padEnd(18)} ${badge}${current}`,
    value: entry.id,
    description: entry.description,
  };
}

function modelChoice(
  modelId: string,
  providerId: string,
  isCurrent: boolean,
): { name: string; value: string; description?: string } {
  const m = listModelsForProvider(providerId).find((x) => x.id === modelId);
  if (!m) {
    return { name: modelId, value: modelId };
  }
  const ctx = m.contextLength ? ` ${(m.contextLength / 1000).toFixed(0)}K ctx` : '';
  let pricing = '';
  if (m.pricing) {
    pricing = ` $${m.pricing.inputPerM}/$${m.pricing.outputPerM} per M`;
  }
  // Phase 22 Task 3: ModelEntry.isDefault is the catalog's "recommended"
  // signal. No separate `recommended` field exists.
  const star = m.isDefault ? ' ⭐ recommended' : '';
  const current = isCurrent ? '  ← current' : '';
  return {
    name: `${m.displayName}${ctx}${pricing}${star}${current}`,
    value: m.id,
    description: m.notes,
  };
}

/** Resolve `@inquirer/prompts` lazily so unit tests can swap it out. */
async function defaultPrompts(): Promise<PickerPrompts> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const inq = require('@inquirer/prompts');
  return {
    async select(opts) {
      return inq.select(opts);
    },
  };
}

export async function runModelPicker(
  opts: ModelPickerOptions,
): Promise<{ providerId: string; modelId: string } | null> {
  const { resolver, spec, tier, currentProviderId, currentModelId } = opts;

  // Spec branch — use Phase 5's parser, no prompts.
  if (spec && spec.trim().length > 0) {
    try {
      const switcher = new ModelSwitcher(resolver);
      const parsed = switcher.parse(spec);
      if (!parsed.providerId) return null;
      return { providerId: parsed.providerId, modelId: parsed.modelId };
    } catch {
      return null;
    }
  }

  const prompts = opts.promptModule ?? (await defaultPrompts());
  const isAuthed = opts.isProviderAuthed ?? (() => true);

  const providerEntries = Object.values(PROVIDER_REGISTRY).filter(
    (e) => !tier || e.tier === tier,
  );
  if (providerEntries.length === 0) return null;

  // Two-step loop: ← Back from stage 2 returns to stage 1 cleanly.
  // Cancel from either stage returns null.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Stage 1 — provider picker.
    const hintParts: string[] = [];
    if (currentProviderId && currentModelId) {
      hintParts.push(`Current: ${currentProviderId} on ${currentModelId}`);
    }
    const stage1Message =
      hintParts.length > 0
        ? `⚙ Model Picker — Select Provider · ${hintParts.join(' · ')}`
        : '⚙ Model Picker — Select Provider';

    const providerChoices = providerEntries.map((e) =>
      providerChoice(
        e,
        listModelsForProvider(e.id).length,
        isAuthed(e.id),
        e.id === currentProviderId,
      ),
    );
    providerChoices.push({ name: 'Cancel', value: CANCEL_VALUE });

    let providerId: string;
    try {
      providerId = await prompts.select({
        message: stage1Message,
        choices: providerChoices,
      });
    } catch {
      return null; // user cancelled (Ctrl+C / Escape)
    }
    if (providerId === CANCEL_VALUE) return null;

    const models = listModelsForProvider(providerId);
    if (models.length === 0) return null;

    // Stage 2 — model picker with breadcrumb.
    const providerEntry = PROVIDER_REGISTRY[providerId];
    const breadcrumb = providerEntry?.displayName ?? providerId;
    const stage2Message = `⚙ Model Picker — ${breadcrumb} · Select a model (${models.length} available)`;

    const modelChoices = models.map((m) =>
      modelChoice(
        m.id,
        providerId,
        providerId === currentProviderId && m.id === currentModelId,
      ),
    );
    modelChoices.push({ name: '← Back', value: BACK_VALUE });
    modelChoices.push({ name: 'Cancel', value: CANCEL_VALUE });

    let modelId: string;
    try {
      modelId = await prompts.select({
        message: stage2Message,
        choices: modelChoices,
      });
    } catch {
      return null;
    }
    if (modelId === CANCEL_VALUE) return null;
    if (modelId === BACK_VALUE) continue; // re-prompt stage 1

    return { providerId, modelId };
  }
}
