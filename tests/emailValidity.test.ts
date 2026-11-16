import { describe, it, expect } from 'vitest';
import { emailProblem, emailDomain } from '@/lib/emailValidity';

// Support only takes a real, reachable email (src/lib/emailValidity.ts). 2026-11-15 probes used
// i147@example.com — a reserved documentation domain that can never receive mail.

describe('emailProblem', () => {
  it.each(['ada@gmail.com', 'Ada.Lovelace+abapay@Outlook.COM', 'ops@sub.company.co.ng', 'x@abapays.com'])('accepts %s', (e) => {
    expect(emailProblem(e)).toBeNull();
  });

  it.each([
    ['i147@example.com', 'RESERVED_DOMAIN'],
    ['a@example.org', 'RESERVED_DOMAIN'],
    ['a@mail.example.net', 'RESERVED_DOMAIN'],
    ['a@foo.test', 'RESERVED_DOMAIN'],
    ['a@foo.invalid', 'RESERVED_DOMAIN'],
    ['a@localhost', 'BAD_FORMAT'],
    ['a@box.localhost', 'RESERVED_DOMAIN'],
    ['not-an-email', 'BAD_FORMAT'],
    ['a@b', 'BAD_FORMAT'],
    ['a b@c.com', 'BAD_FORMAT'],
    ['a@-bad.com', 'BAD_FORMAT'],
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
  ])('refuses %s (%s)', (e, why) => {
    expect(emailProblem(e)).toBe(why);
  });

  it('reads the domain', () => expect(emailDomain(' Ada@GMAIL.com ')).toBe('gmail.com'));
});
