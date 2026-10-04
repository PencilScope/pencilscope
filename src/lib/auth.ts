type SessionReader = {
  get(key: string): Promise<unknown>;
};

export type AuthenticatedActor = {
  id: string;
  role: "tutor" | "admin";
};

export async function getTutorActor(
  session: SessionReader | undefined,
  db: D1Database
): Promise<AuthenticatedActor | null> {
  const userId = await session?.get("userId");
  if (typeof userId !== "string" || !userId) return null;

  return getTutorActorById(userId, db);
}

export async function getTutorActorById(
  userId: string | null,
  db: D1Database
): Promise<AuthenticatedActor | null> {
  if (!userId) return null;
  const user = await db.prepare(
    `SELECT u.id, u.role, u.status, tp.verification_status
     FROM users u
     LEFT JOIN tutor_profiles tp ON tp.user_id = u.id
     WHERE u.id = ?`
  ).bind(userId).first<{
    id: string;
    role: string;
    status: string;
    verification_status: string | null;
  }>();

  if (!user || user.status !== "active") return null;
  if (user.role === "admin") return { id: user.id, role: "admin" };
  if (user.role === "tutor" && user.verification_status === "approved") {
    return { id: user.id, role: "tutor" };
  }
  return null;
}
