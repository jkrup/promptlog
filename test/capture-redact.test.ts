import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRedactor, loadRedactConfig, redactText, repoRedactor } from '../src/capture/redact.ts';
import { tempRepo } from './helpers.ts';

// Fake credentials assembled at runtime so this file doesn't trip secret scanners.
const j = (...p: string[]) => p.join('');
const SECRETS: [string, string, string][] = [
  ['aws-access-key', j('AKIA', 'IOSFODNN7EXAMPLE'), 'key AKIA… in text'],
  ['github-token', j('ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'), ''],
  ['github-token', j('github_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRST'), ''],
  ['gitlab-token', j('glpat-', 'abcdefghij0123456789'), ''],
  ['slack-token', j('xoxb-', '123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'), ''],
  ['stripe-key', j('sk_live_', '4eC39HqLyjWDarjtT1zdp7dc'), ''],
  ['stripe-key', j('sk_test_', '4eC39HqLyjWDarjtT1zdp7dc'), ''],
  ['anthropic-key', j('sk-ant-', 'api03-abcdefghijklmnopqrstuvwxyz0123456789-ABCDEFG_hij'), ''],
  ['openai-key', j('sk-', 'proj-abcdefghijklmnop1234567890ABCDEF'), ''],
  ['openai-key', j('sk-', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'), ''],
  ['jwt', j('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'), ''],
  ['google-api-key', j('AIza', 'SyA1234567890abcdefghijklmnopqrstuv'), ''],
];

test('redactText: provider token formats', () => {
  for (const [kind, secret] of SECRETS) {
    const out = redactText(`use ${secret} now`);
    assert.equal(out, `use [REDACTED:${kind}] now`, kind);
  }
});

test('redactText: AWS secret keys, PEM private keys, bearer tokens, URL passwords', () => {
  assert.equal(redactText(j('aws_secret_access_key = ', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')), 'aws_secret_access_key = [REDACTED:aws-secret-key]');
  const pem = j('-----BEGIN RSA PRIVATE', ' KEY-----\nMIIEpAIBAAKCAQEA1234567890abcdef\nabcdefABCDEF0123456789+/==\n-----END RSA PRIVATE', ' KEY-----');
  assert.equal(redactText(`before\n${pem}\nafter`), 'before\n[REDACTED:private-key]\nafter');
  const truncated = j('-----BEGIN OPENSSH PRIVATE', ' KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n(output truncated)');
  assert.equal(redactText(truncated), '[REDACTED:private-key]\n(output truncated)');
  assert.equal(redactText('Authorization: Bearer abcdef0123456789abcdef0123456789'), 'Authorization: Bearer [REDACTED:bearer-token]');
  assert.equal(redactText('postgres://admin:s3cretPw@db:5432/app'), 'postgres://admin:[REDACTED:url-password]@db:5432/app');
  assert.equal(redactText('https://user:${PW}@host/x'), 'https://user:${PW}@host/x');
});

test('redactText: password=/secret=/token=/api_key= assignments', () => {
  const cases: [string, string][] = [
    ['password=hunter22', 'password=[REDACTED:password]'],
    ['DB_PASSWORD=supersecret', 'DB_PASSWORD=[REDACTED:password]'],
    ['secret=abc123xyz', 'secret=[REDACTED:secret]'],
    ['GITHUB_TOKEN=whatever1', 'GITHUB_TOKEN=[REDACTED:token]'],
    ['curl "https://x.io/?api_key=abcd1234&page=2"', 'curl "https://x.io/?api_key=[REDACTED:api-key]&page=2"'],
    ['mysql --password=hunter22 -u root', 'mysql --password=[REDACTED:password] -u root'],
    ['client_secret = "s3cr3t value"', 'client_secret = "[REDACTED:secret]"'],
    ['{"password": "correcthorse", "token": "<your-token>"}', '{"password": "[REDACTED:password]", "token": "<your-token>"}'],
    ['db:\n  password: hunter2\n', 'db:\n  password: [REDACTED:password]\n'],
    ['     3→API_KEY=abcd1234efgh', '     3→API_KEY=[REDACTED:api-key]'],
  ];
  for (const [input, want] of cases) assert.equal(redactText(input), want, input);
});

test('redactText: high-entropy dotenv values; low-entropy ones stay', () => {
  const env = ['NODE_ENV=production', 'PORT=3000', 'SESSION_SIGNING=Zx8qP1mN4vB7cR2tY5uI9oL3kJ6hG0fD', 'export WEBHOOK_SIG="abcdefghij0123456789ABCDEF"', 'PATH=/usr/local/bin:/usr/bin:/bin2'].join('\n');
  assert.equal(
    redactText(env),
    ['NODE_ENV=production', 'PORT=3000', 'SESSION_SIGNING=[REDACTED:high-entropy]', 'export WEBHOOK_SIG="[REDACTED:high-entropy]"', 'PATH=/usr/local/bin:/usr/bin:/bin2'].join('\n'),
  );
});

test('redactText: leaves ordinary code and prose alone', () => {
  const code = [
    'const token = getToken();',
    'if (token==null) return;',
    'password = input("Password: ")',
    'const secret = process.env.SECRET',
    'interface Creds { password: string; token: string }',
    'max_tokens=4096 input_tokens: 12 MAX_TOKEN=100',
    'export PASSWORD=$DB_PASS',
    'password=${PASSWORD} token=<token> secret=*** api_key=changeme',
    'task-sk-list and desk-lamp and the gh_pages branch',
    'uuid 8f14e45f-ceea-467a-9a36-dedd4bea2543 and sha 3b1aa6426378',
    'See https://example.com/docs?page=2 and user@example.com',
  ].join('\n');
  assert.equal(redactText(code), code);
});

test('redactText: idempotent on already-redacted text', () => {
  const once = redactText(j('password=hunter22 ', 'sk_live_4eC39HqLyjWDarjtT1zdp7dc'));
  assert.equal(redactText(once), once);
});

test('createRedactor: JSONL lines stay valid JSON, structural fields are untouched', () => {
  const r = createRedactor();
  const key = j('sk-ant-', 'api03-abcdefghijklmnopqrstuvwxyz0123456789');
  const entry = {
    type: 'user',
    uuid: 'b2a7-uuid',
    promptId: 'p1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `line1\nAPI_KEY=${key}\n"quoted"` }] },
    toolUseResult: { stdout: `API_KEY=${key}` },
    signature: key, // e.g. thinking signatures: never modified
    image: { type: 'base64', data: key },
  };
  const out = r(JSON.stringify(entry));
  const parsed = JSON.parse(out);
  assert.equal(parsed.message.content[0].content, 'line1\nAPI_KEY=[REDACTED:anthropic-key]\n"quoted"');
  assert.equal(parsed.toolUseResult.stdout, 'API_KEY=[REDACTED:anthropic-key]');
  assert.equal(parsed.signature, key);
  assert.equal(parsed.image.data, key);
  assert.equal(parsed.uuid, 'b2a7-uuid');
  // Unchanged lines are returned byte-for-byte.
  const clean = '{"type":"assistant", "message":{"content":"hello"}}';
  assert.equal(r(clean), clean);
});

test('createRedactor: unparseable lines fall back to raw regex; multi-line input keeps line count', () => {
  const r = createRedactor();
  const key = j('ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
  assert.equal(r(`{"truncated": "${key}`), '{"truncated": "[REDACTED:github-token]');
  assert.equal(r('{"a":"x\\npassword=hunter22\\ny"'), '{"a":"x\\npassword=[REDACTED:password]\\ny"');
  const file = [JSON.stringify({ t: key }), 'not json ' + key, ''].join('\n');
  const out = r(file).split('\n');
  assert.equal(out.length, 3);
  assert.deepEqual(JSON.parse(out[0]!), { t: '[REDACTED:github-token]' });
  assert.equal(out[1], 'not json [REDACTED:github-token]');
});

test('.promptlog/redact.json: extra patterns, named secret group, disable, allow, bad entries', () => {
  const repo = tempRepo();
  mkdirSync(join(repo, '.promptlog'));
  writeFileSync(
    join(repo, '.promptlog', 'redact.json'),
    JSON.stringify({
      patterns: [
        { name: 'corp-token', regex: 'corp_[a-z0-9]{12}', flags: 'i' },
        { name: 'ticket-pin', regex: 'PIN:(?<secret>\\d{4})' },
        { name: 'broken', regex: '([' },
      ],
      disable: ['high-entropy'],
      allow: ['sk_test_4eC39HqLyjWDarjtT1zdp7dc'],
    }),
  );
  const warnings: string[] = [];
  const r = repoRedactor(repo, (m) => warnings.push(m));
  assert.equal(r('call CORP_abcdef123456 with PIN:1234'), 'call [REDACTED:corp-token] with PIN:[REDACTED:ticket-pin]');
  assert.equal(r('SESSION_SIGNING=Zx8qP1mN4vB7cR2tY5uI9oL3kJ6hG0fD'), 'SESSION_SIGNING=Zx8qP1mN4vB7cR2tY5uI9oL3kJ6hG0fD');
  assert.equal(r(j('sk_test_', '4eC39HqLyjWDarjtT1zdp7dc')), j('sk_test_', '4eC39HqLyjWDarjtT1zdp7dc'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /broken/);
  assert.ok(!warnings[0]!.includes('(['), 'never echoes the pattern');

  // Map form, and an unreadable file falls back to built-ins with a warning.
  writeFileSync(join(repo, '.promptlog', 'redact.json'), JSON.stringify({ patterns: { internal: 'INT-[0-9]{6}' } }));
  assert.equal(repoRedactor(repo)('id INT-123456'), 'id [REDACTED:internal]');
  writeFileSync(join(repo, '.promptlog', 'redact.json'), '{ nope');
  const w2: string[] = [];
  assert.equal(loadRedactConfig(repo, (m) => w2.push(m)), undefined);
  assert.equal(w2.length, 1);
  assert.equal(repoRedactor(repo)('password=hunter22'), 'password=[REDACTED:password]');
});
