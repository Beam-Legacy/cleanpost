import { prepareTestDatabase } from '@cleanpost/db/testing';

export default async function setup() {
  await prepareTestDatabase('notify');
}
