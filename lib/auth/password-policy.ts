// Password requirements, shared by the form and the server action.
//
// Deliberately NOT in the `'use server'` action file: such a file may only export async
// functions, so a plain helper there is a build error — and more importantly, the form needs
// to import this to show live feedback. One definition means a client-side rule the server
// does not enforce (theatre) and a server rule the client does not show (a guessing game) are
// both impossible.

export interface PasswordCheck {
  met: (password: string) => boolean
  label: string
  /** Phrasing for the server's error sentence: "your password needs …". */
  requirement: string
}

export const PASSWORD_CHECKS: PasswordCheck[] = [
  {
    met: (p) => p.length >= 12,
    label: 'At least 12 characters',
    requirement: 'at least 12 characters',
  },
  { met: (p) => /[a-z]/.test(p), label: 'One lowercase letter', requirement: 'one lowercase letter' },
  { met: (p) => /[A-Z]/.test(p), label: 'One uppercase letter', requirement: 'one uppercase letter' },
  { met: (p) => /[0-9]/.test(p), label: 'One number', requirement: 'one number' },
  {
    met: (p) => /[^A-Za-z0-9]/.test(p),
    label: 'One special character',
    requirement: 'one special character',
  },
]

/** Everything this password is still missing. Empty means acceptable. */
export function passwordProblems(password: string): string[] {
  return PASSWORD_CHECKS.filter((c) => !c.met(password)).map((c) => c.requirement)
}
