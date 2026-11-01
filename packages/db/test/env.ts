/** Test database URLs. CI sets them; locally they default to the docker-compose database. */
export const TEST_DATABASE_ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://cleanpost:cleanpost@localhost:5432/cleanpost_test';
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://cleanpost_web:cleanpost_web@localhost:5432/cleanpost_test';
