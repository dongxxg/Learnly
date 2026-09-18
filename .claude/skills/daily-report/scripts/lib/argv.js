'use strict';

function parseArgs(argv, spec) {
  const result = {
    flags: {},
    options: {},
    positional: [],
  };

  for (const flag of spec.flags || []) {
    result.flags[flag] = false;
  }
  for (const opt of Object.keys(spec.options || {})) {
    result.options[opt] = spec.options[opt];
  }

  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') {
      result.positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        if (spec.flags && spec.flags.includes(key)) {
          result.flags[key] = true;
        } else {
          result.options[key] = val;
        }
      } else {
        const key = arg.slice(2);
        if (spec.flags && spec.flags.includes(key)) {
          result.flags[key] = true;
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
          result.options[key] = argv[i + 1];
          i++;
        } else {
          result.options[key] = true;
        }
      }
    } else {
      result.positional.push(arg);
    }
    i++;
  }

  return result;
}

module.exports = { parseArgs };
