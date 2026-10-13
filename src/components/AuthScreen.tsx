import { useState, type FormEvent } from 'react'
import { Eye, EyeOff, LockKeyhole, Moon, ShieldCheck, Sun } from 'lucide-react'

type Props = {
  busy: boolean
  error: string | null
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  onSubmit: (mode: 'login' | 'register', email: string, password: string) => Promise<unknown>
}

export function AuthScreen({ busy, error, theme, onToggleTheme, onSubmit }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [visible, setVisible] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setLocalError(null)
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') ?? '').trim()
    const password = String(form.get('password') ?? '')
    if (!email || !password) {
      setLocalError('Enter your email and password.')
      return
    }
    if (mode === 'register' && password.length < 10) {
      setLocalError('Use at least 10 characters for your password.')
      return
    }
    try {
      await onSubmit(mode, email.trim(), password)
    } catch {
      // The server error is rendered below without clearing either credential field.
    }
  }

  return (
    <main className="auth-shell">
      <button className="auth-theme-toggle" type="button" onClick={onToggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
        {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
      </button>
      <section className="auth-card">
        <div className="auth-brand"><span className="brand-mark"><span /><span /></span><span className="brand-name">ANTY<span>TILT</span></span></div>
        <div className="auth-intro"><ShieldCheck size={22} /><div><strong>Your terminal. Your trading rules.</strong><small>Sign in before connecting an exchange account.</small></div></div>
        <div className="auth-tabs">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setLocalError(null) }}>Sign in</button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setLocalError(null) }}>Create account</button>
        </div>
        <form onSubmit={submit}>
          <label><span>Email</span><input name="email" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} placeholder="trader@example.com" required autoFocus /></label>
          <label><span>Password</span><div className="auth-password"><input name="password" type={visible ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder={mode === 'register' ? 'At least 10 characters' : 'Your password'} required /><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => setVisible((current) => !current)} aria-label={visible ? 'Hide password' : 'Show password'}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
          {(localError || error) && <div className="auth-error" role="alert" aria-live="polite">{localError || error}</div>}
          <button className="auth-submit" disabled={busy}><LockKeyhole size={15} />{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create secure account'}</button>
        </form>
      </section>
    </main>
  )
}
