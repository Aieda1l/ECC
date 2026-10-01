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
 *
 * This file intentionally has no npm runtime dependencies so it also works from
 * Codex's isolated native-plugin cache.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

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
  if (capabilities.browserInteractionMode === 'manual') return null;

  if (capabilities.proAvailable === true) {
    return { model: 'chatgpt-web/gpt-6-pro', effort: 'max', account: 'Pro' };
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
  // JSON double-quoted strings are valid TOML basic strings for these ASCII model IDs/efforts.
  return JSON.stringify(value);
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

function updateInlineAgents(line, selection) {
  const match = line.match(/^(\s*agents\s*=\s*\{)(.*)(\}\s*(?:#.*)?)$/);
  if (!match) return null;

  let body = match[2].trim();
  const entries = [
    ['default_subagent_model', selection.model],
    ['default_subagent_reasoning_effort', selection.effort],
  ];

  for (const [key, value] of entries) {
    const pattern = new RegExp(
      String.raw`(^|,\s*)(${key}\s*=\s*)(?:"(?:\\.|[^"])*"|'[^']*'|[^,}]+)`,
    );
    if (pattern.test(body)) {
      body = body.replace(pattern, (_all, prefix, assignment) =>
        prefix + assignment + tomlString(value));
    } else {
      body += (body ? ', ' : '') + key + ' = ' + tomlString(value);
    }
  }

  return match[1] + (body ? ' ' + body + ' ' : '') + match[3];
}

function updateCodexConfig(raw, selection) {
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const normalized = raw.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const agentsHeader = lines.findIndex(line => /^\s*\[agents\]\s*(?:#.*)?$/.test(line));

  if (agentsHeader >= 0) {
    let end = findTableEnd(lines, agentsHeader);
    replaceOrInsertKey(lines, agentsHeader, end, 'default_subagent_model', selection.model);
    end = findTableEnd(lines, agentsHeader);
    replaceOrInsertKey(
      lines,
      agentsHeader,
      end,
      'default_subagent_reasoning_effort',
      selection.effort,
    );
    return lines.join(newline);
  }

  const inlineAgents = lines.findIndex(line => /^\s*agents\s*=\s*\{.*\}\s*(?:#.*)?$/.test(line));
  if (inlineAgents >= 0) {
    const updated = updateInlineAgents(lines[inlineAgents], selection);
    if (!updated) throw new Error('Could not safely update inline agents configuration');
    lines[inlineAgents] = updated;
    return lines.join(newline);
  }

  const firstAgentsSubtable = lines.findIndex(
    line => /^\s*\[agents\.[^\]]+\]\s*(?:#.*)?$/.test(line),
  );
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

  return lines.join(newline);
}

function parseArgs(argv) {
  const result = { configPath: undefined, webConfigPath: undefined, dryRun: false };

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
  updateInlineAgents,
};
