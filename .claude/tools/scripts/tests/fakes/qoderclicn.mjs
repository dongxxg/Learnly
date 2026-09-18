#!/usr/bin/env node
const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('qoderclicn fake 1.0.0\n');
  process.exit(0);
}

const payload = JSON.stringify({
  type: 'result',
  result: JSON.stringify({
    exit_status: 'DONE',
    summary: args.join('|'),
    artifacts: ['fake-artifact.txt'],
  }),
  usage: { total: 42 },
});
const delayMs = Number(process.env.QODER_FAKE_DELAY_MS || 0);
if (delayMs > 0) setTimeout(() => process.stdout.write(payload), delayMs);
else process.stdout.write(payload);
