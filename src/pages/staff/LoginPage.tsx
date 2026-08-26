import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';

export default function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);
    if (error) {
      // デバッグ用に実際のエラー内容をそのまま表示する。
      // (原因診断ができたら、ユーザー向けの文言に差し替える)
      console.error('signInWithPassword error:', error);
      setError(`ログインエラー: ${error.message} (status: ${error.status ?? '?'})`);
      return;
    }
    navigate('/staff');
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg)]">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-white rounded-xl border border-neutral-200 p-8 flex flex-col gap-4"
      >
        <h1 className="text-xl font-bold text-center">スタッフログイン</h1>

        <label className="flex flex-col gap-1 text-sm">
          メールアドレス
          <input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-11 border border-neutral-300 rounded px-3"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          パスワード
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-11 border border-neutral-300 rounded px-3"
          />
        </label>

        {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="h-12 rounded-lg bg-[var(--color-primary)] text-white font-bold disabled:opacity-50"
        >
          {submitting ? 'ログイン中…' : 'ログイン'}
        </button>

        <p className="text-xs text-neutral-400 text-center">
          アカウントはSupabaseダッシュボード(Authentication)と
          <code>staff</code>テーブルへの登録で作成します
          (04_データベース設計書.md 13章参照)。
        </p>
      </form>
    </div>
  );
}
