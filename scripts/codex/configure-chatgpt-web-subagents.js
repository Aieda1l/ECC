#!/usr/bin/env node
'use strict';

/**
 * Configure Codex subagent defaults for the strongest automatic model exposed by
 * miuuyy/codex-chatgpt-web for the current ChatGPT account.
 *
 * Selection policy:
 * - Pro -> GPT-6 Pro / max
 * - Sol + Extra High -> GPT-5.6 Sol / xhigh
 * - Sol (Plus default) -> GPT-5.6 Sol / high
 * - Luna-only (Free/Go) -> GPT-5.6 Luna / medium (Think)
 *
 * Zero Risk/manual mode is intentionally left untouched because autonomous
 * subagents cannot complete its human paste/send confirmation loop.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let TOML;
try {
  TOML = require('@iarna/toml');
} catch {
  console.error('[ecc-codex-web] Missing dependency: @iarna/toml');
  console.error('[ecc-codex-web] Run: npm install   (from the ECC repo root)');
  process.exit(1);
}

const DEFAULT_PLUS = Object.freeze({
  model: 'chatgpt-web/gpt-5.6-sol',
  effort: 'high',
  account: 'Plus (default)',
});

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function defaultCodexConfigPath(env = process.env) {
  return path.join(expandHome(env.CODEX_HOME || '~/.codex'), 'config.toml');
}

function defaultWebConfigPath(env = process.env) {
  return path.join(expandHome(env.CODEX_CHATGPT_WEB_HOME || '~/.codex-chatgpt-web'), 'config.json');
}

function selectSubagentDefaults(capabilities) {
  if (!capabilities) return { ...DEFAULT_PLUS };

  if (capabilities.browserInteractionMode === 'manual') {
    return null;
  }

  if (capabilities.proAvailable === true) {
    return {
      model: 'chatgpt-web/gpt-6-pro',
      effort: 'max',
      account: 'Pro',
    };
  }

  if (capabilities.solAvailable === false) {
    return {
      model: 'chatgpt-web/gpt-5.6-luna',
      effort: 'medium',
      account: 'Luna-only (Free/Go)',
    };
  }

  if (capabilities.extraHighAvailable === true) {
    return {
      model: 'chatgpt-web/gpt-5.6-sol',
      effort: 'xhigh',
      account: 'Sol + Extra High',
    };
  }

  return { ...DEFAULT_PLUS };
}

function readCapabilities(webConfigPath) {
  if (!fs.existsSync(webConfigPath)) {
    return { capabilities: null, usedDefaultPlus: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(webConfigPath, 'utf8'));
  } catch (error) {
    throw new Error('Could not parse codex-chatgpt-web config at ' + webConfigPath + ': ' + error.message);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('codex-chatgpt-web config at ' + webConfigPath + ' must be a JSON object');
  }

  return { capabilities: parsed, usedDefaultPlus: false };
}

function tomlString(value) {
  return TOML.stringify({ value }).trim().replace(/^value = /, '');
}

function serializeAgentsTable(agents) {
  return TOML.stringify({ agents }).trim();
}

function findTableEnd(lines, startIndex) {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(lines[index])) return index;
  }
  return lines.length;
}

function replaceOrInsertKey(lines, startIndex, endIndex, key, value) {
  const pattern = new RegExp('^(\\s*)' + key + '\\s*=.*$');
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    if (pattern.test(lines[index])) {
      const indent = (lines[index].match(/^\s*/) || [''])[0];
      lines[index] = indent + key + ' = ' + tomlString(value);
      return;
    }
  }
  lines.splice(endIndex, 0, key + ' = ' + tomlString(value));
}

function updateCodexConfig(raw, selection) {
  let parsed;
  try {
    parsed = TOML.parse(raw);
  } catch (error) {
    throw new Error('Could not parse Codex config.toml: ' + error.message);
  }

  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const agentsHeader = lines.findIndex(line => /^\s*\[agents\]\s*(?:#.*)?$/.test(line));

  if (agentsHeader >= 0) {
    let end = findTableEnd(lines, agentsHeader);
    replaceOrInsertKey(lines, agentsHeader, end, 'default_subagent_model', selection.model);
    end = findTableEnd(lines, agentsHeader);
    replaceOrInsertKey(lines, agentsHeader, end, 'default_subagent_reasoning_effort', selection.effort);
    const next = lines.join('\n');
    TOML.parse(next);
    return next;
  }

  const inlineAgents = lines.findIndex(line => /^\s*agents\s*=\s*\{.*\}\s*(?:#.*)?$/.test(line));
  if (inlineAgents >= 0) {
    const current = parsed.agents && typeof parsed.agents === 'object' && !Array.isArray(parsed.agents)
      ? parsed.agents
      : {};
    const replacement = serializeAgentsTable({
      ...current,
      default_subagent_model: selection.model,
      default_subagent_reasoning_effort: selection.effort,
    });
    lines.splice(inlineAgents, 1, ...replacement.split('\n'));
    const next = lines.join('\n');
    TOML.parse(next);
    return next;
  }

  const firstAgentsSubtable = lines.findIndex(line => /^\s*\[agents\.[^\]]+\]\s*(?:#.*)?$/.test(line));
  const block = [
    '[agents]',
    'default_subagent_model = ' + tomlString(selection.model),
    'default_subagent_reasoning_effort = ' + tomlString(selection.effort),
    '',
  ];

  if (firstAgentsSubtable >= 0) {
    lines.splice(firstAgentsSubtable, 0, ...block);
  } else {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push(...block);
  }

  const next = lines.join('\n');
  TOML.parse(next);
  return next;
}

function parseArgs(argv) {
  const result = {
    configPath: undefined,
    webConfigPath: undefined,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--config') {
      result.configPath = argv[++index];
      if (!result.configPath) throw new Error('--config requires a path');
    } else if (arg === '--web-config') {
      result.webConfigPath = argv[++index];
      if (!result.webConfigPath) throw new Error('--web-config requires a path');
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else {
      throw new Error('Unknown argument: ' + arg);
    }
  }

  return result;
}

function usage() {
  return [
    'Usage: configure-chatgpt-web-subagents.js [options]',
    '',
    'Options:',
    '  --config PATH      Codex config.toml (default: $CODEX_HOME/config.toml or ~/.codex/config.toml)',
    '  --web-config PATH  codex-chatgpt-web config.json (default: $CODEX_CHATGPT_WEB_HOME/config.json)',
    '  --dry-run          Print the selected defaults without writing config.toml',
    '  -h, --help         Show this help',
  ].join('\n');
}

function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const configPath = expandHome(args.configPath || defaultCodexConfigPath(env));
  const webConfigPath = expandHome(args.webConfigPath || defaultWebConfigPath(env));

  if (!fs.existsSync(configPath)) {
    throw new Error('Codex config.toml not found: ' + configPath);
  }

  const { capabilities, usedDefaultPlus } = readCapabilities(webConfigPath);
  const selection = selectSubagentDefaults(capabilities);

  if (!selection) {
    console.log('[ecc-codex-web] codex-chatgpt-web is in Zero Risk/manual mode; leaving subagent defaults unchanged.');
    console.log('[ecc-codex-web] Automatic subagents require Automatic mode because Zero Risk needs human paste/send confirmation.');
    return 0;
  }

  if (usedDefaultPlus) {
    console.log('[ecc-codex-web] No codex-chatgpt-web config found at ' + webConfigPath + '; using the requested Plus default.');
  }

  console.log(
    '[ecc-codex-web] Subagents: ' + selection.model + ' / ' + selection.effort + ' (' + selection.account + ')',
  );

  const raw = fs.readFileSync(configPath, 'utf8');
  const next = updateCodexConfig(raw, selection);
  if (next === raw) {
    console.log('[ecc-codex-web] Codex subagent defaults are already current.');
    return 0;
  }

  if (args.dryRun) {
    console.log('[ecc-codex-web] Dry run: would update ' + configPath);
    return 0;
  }

  fs.writeFileSync(configPath, next, 'utf8');
  console.log('[ecc-codex-web] Updated ' + configPath);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error('[ecc-codex-web] ERROR: ' + error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_PLUS,
  defaultCodexConfigPath,
  defaultWebConfigPath,
  readCapabilities,
  selectSubagentDefaults,
  updateCodexConfig,
};
