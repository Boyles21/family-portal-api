export type Role = 'owner' | 'admin' | 'editor' | 'member';

export const ROLE_RANK: Record<Role, number> = { member: 0, editor: 1, admin: 2, owner: 3 };

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
}

export interface Membership {
  familyId: string;
  userId: string;
  role: Role;
  personId: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      membership?: Membership;
    }
  }
}
