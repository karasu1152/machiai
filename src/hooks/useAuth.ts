import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { StaffRow } from '../lib/types';

interface AuthState {
  loading: boolean;
  session: Session | null;
  staff: StaffRow | null;
}

// 認証状態 + staffテーブルの自分の行(tenant_id・role)をまとめて返すフック。
// (08_開発指示プロンプト.md ディレクトリ構成の useAuth.ts に相当)
export function useAuth(): AuthState & { signOut: () => Promise<void> } {
  const [state, setState] = useState<AuthState>({ loading: true, session: null, staff: null });

  useEffect(() => {
    let active = true;

    async function loadStaff(session: Session | null) {
      if (!session) {
        if (active) setState({ loading: false, session: null, staff: null });
        return;
      }
      const { data } = await supabase
        .from('staff')
        .select('id, tenant_id, display_name, role, is_active')
        .eq('id', session.user.id)
        .maybeSingle();
      if (active) setState({ loading: false, session, staff: (data as StaffRow) ?? null });
    }

    supabase.auth.getSession().then(({ data }) => loadStaff(data.session));

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      loadStaff(session);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
  }

  return { ...state, signOut };
}
