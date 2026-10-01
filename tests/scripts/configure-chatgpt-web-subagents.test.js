const assert = require('assert');
const TOML = require('@iarna/toml');
const {
  DEFAULT_PLUS,
  selectSubagentDefaults,
  updateCodexConfig,
} = require('../../scripts/codex/configure-chatgpt-web-subagents');

function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
    return true;
  } catch (error) {
    console.log('  ✗ ' + name);
    console.log('    Error: ' + error.message);
    return false;
  }
}

function runTests() {
  console.log('\n=== Testing ChatGPT Web Codex subagent selection ===\n');

  let passed = 0;
  let failed = 0;

  if (test('defaults to Plus Sol High when no account observation exists', () => {
    assert.deepStrictEqual(selectSubagentDefaults(null), DEFAULT_PLUS);
  })) passed++; else failed++;

  if (test('selects GPT-6 Pro with max reasoning for Pro accounts', () => {
    assert.deepStrictEqual(selectSubagentDefaults({
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
      browserInteractionMode: 'automatic',
    }), {
      model: 'chatgpt-web/gpt-6-pro',
      effort: 'max',
      account: 'Pro',
    });
  })) passed++; else failed++;

  if (test('selects Sol Extra High only when the account exposes it', () => {
    assert.deepStrictEqual(selectSubagentDefaults({
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: false,
      browserInteractionMode: 'automatic',
    }), {
      model: 'chatgpt-web/gpt-5.6-sol',
      effort: 'xhigh',
      account: 'Sol + Extra High',
    });
  })) passed++; else failed++;

  if (test('keeps ordinary Plus accounts on Sol High', () => {
    assert.deepStrictEqual(selectSubagentDefaults({
      solAvailable: true,
      extraHighAvailable: false,
      proAvailable: false,
      browserInteractionMode: 'automatic',
    }), DEFAULT_PLUS);
  })) passed++; else failed++;

  if (test('uses Luna Think for Luna-only accounts', () => {
    assert.deepStrictEqual(selectSubagentDefaults({
      solAvailable: false,
      extraHighAvailable: false,
      proAvailable: false,
      browserInteractionMode: 'automatic',
    }), {
      model: 'chatgpt-web/gpt-5.6-luna',
      effort: 'medium',
      account: 'Luna-only (Free/Go)',
    });
  })) passed++; else failed++;

  if (test('does not automate Zero Risk/manual mode', () => {
    assert.strictEqual(selectSubagentDefaults({
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
      browserInteractionMode: 'manual',
    }), null);
  })) passed++; else failed++;

  if (test('updates an existing [agents] table without disturbing other keys', () => {
    const source = [
      'approval_policy = "on-request"',
      '',
      '[agents]',
      'max_threads = 6',
      'max_depth = 1',
      '',
      '[agents.reviewer]',
      'description = "review"',
      '',
    ].join('\n');

    const updated = updateCodexConfig(source, {
      model: 'chatgpt-web/gpt-5.6-sol',
      effort: 'xhigh',
    });
    const parsed = TOML.parse(updated);

    assert.strictEqual(parsed.agents.default_subagent_model, 'chatgpt-web/gpt-5.6-sol');
    assert.strictEqual(parsed.agents.default_subagent_reasoning_effort, 'xhigh');
    assert.strictEqual(parsed.agents.max_threads, 6);
    assert.strictEqual(parsed.agents.reviewer.description, 'review');
  })) passed++; else failed++;

  if (test('creates [agents] before an existing role subtable', () => {
    const source = [
      '[agents.reviewer]',
      'description = "review"',
      '',
    ].join('\n');

    const updated = updateCodexConfig(source, DEFAULT_PLUS);
    const parsed = TOML.parse(updated);

    assert.strictEqual(parsed.agents.default_subagent_model, DEFAULT_PLUS.model);
    assert.strictEqual(parsed.agents.default_subagent_reasoning_effort, DEFAULT_PLUS.effort);
    assert.strictEqual(parsed.agents.reviewer.description, 'review');
  })) passed++; else failed++;

  if (test('is idempotent after applying the same selection', () => {
    const source = [
      '[agents]',
      'max_threads = 6',
      '',
    ].join('\n');
    const once = updateCodexConfig(source, DEFAULT_PLUS);
    const twice = updateCodexConfig(once, DEFAULT_PLUS);
    assert.strictEqual(twice, once);
  })) passed++; else failed++;

  console.log('\nPassed: ' + passed);
  console.log('Failed: ' + failed);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
