import { NextRequest, NextResponse } from 'next/server';
import { ensureDatabaseSchema, query } from '@/server/db/client';
import { requireRepositoryAccess, handleAuthApiError } from '@/server/auth/authHelper';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureDatabaseSchema();
    const { id } = await params;
    const { user } = await requireRepositoryAccess(id, req);

    const result = await query(
      `UPDATE repositories
       SET last_opened_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id, last_opened_at`,
      [id, user.id]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Repository not found.' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      id: result.rows[0].id,
      last_opened_at: result.rows[0].last_opened_at,
    });
  } catch (error: unknown) {
    return handleAuthApiError(error);
  }
}

