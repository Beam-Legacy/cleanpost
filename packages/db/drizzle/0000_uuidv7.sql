-- UUIDv7 for SQL-side inserts (seeds, system tasks). The app generates its own with the same layout.
-- Named like Postgres 18's built-in so it can be dropped after an upgrade.
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid
  LANGUAGE sql VOLATILE
  AS $$
    SELECT encode(
      set_bit(
        set_bit(
          overlay(uuid_send(gen_random_uuid())
                  placing substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
                  from 1 for 6),
          52, 1),
        53, 1),
      'hex')::uuid
  $$;
