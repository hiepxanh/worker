import { PoolClient } from "pg";

import { migrations } from "./generated/sql";
import { WorkerSharedOptions } from "./interfaces";
import { BREAKING_MIGRATIONS, processSharedOptions } from "./lib";

function checkPostgresVersion(versionString: string) {
  const version = parseInt(versionString, 10);

  if (version < 120000) {
    throw new Error(
      `This version of Graphile Worker requires PostgreSQL v12.0 or greater (detected \`server_version_num\` = ${versionString})`,
    );
  }
}

async function fetchAndCheckPostgresVersion(client: PoolClient) {
  const {
    rows: [row],
  } = await client.query(
    "select current_setting('server_version_num') as server_version_num",
  );
  checkPostgresVersion(row.server_version_num);
}

async function installSchema(options: WorkerSharedOptions, client: PoolClient) {
  const { escapedWorkerSchema } = processSharedOptions(options);

  await fetchAndCheckPostgresVersion(client);

  await client.query(`
    create schema if not exists ${escapedWorkerSchema};
    create table if not exists ${escapedWorkerSchema}.migrations(
      id int primary key,
      ts timestamptz default now() not null
    );
    alter table ${escapedWorkerSchema}.migrations add column if not exists breaking boolean not null default false;
  `);
  await client.query(
    `update ${escapedWorkerSchema}.migrations set breaking = true where id = any($1::int[])`,
    [BREAKING_MIGRATIONS],
  );
}

async function runMigration(
  options: WorkerSharedOptions,
  client: PoolClient,
  migrationFile: keyof typeof migrations,
  migrationNumber: number,
) {
  const { escapedWorkerSchema, logger } = processSharedOptions(options);
  const rawText = migrations[migrationFile];
  const text = rawText.replace(
    /:GRAPHILE_WORKER_SCHEMA\b/g,
    escapedWorkerSchema,
  );
  const breaking = BREAKING_MIGRATIONS.includes(migrationNumber);
  logger.debug(
    `Running ${
      breaking ? "breaking" : "backwards-compatible"
    } migration ${migrationFile}`,
  );
  let migrationInsertComplete = false;
  await client.query("begin");
  try {
    // Must come first so we can detect concurrent migration
    await client.query({
      text: `insert into ${escapedWorkerSchema}.migrations (id, breaking) values ($1, $2)`,
      values: [migrationNumber, breaking],
    });
    migrationInsertComplete = true;
    await client.query({
      text,
    });
    await client.query("select pg_notify($1, $2)", [
      "jobs:migrate",
      JSON.stringify({ migrationNumber, breaking }),
    ]);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    if (!migrationInsertComplete && e.code === "23505") {
      // Someone else did this migration! Success!
      logger.debug(
        `Some other worker has performed migration ${migrationFile}; continuing.`,
      );
      return;
    }
    throw e;
  }
}

export async function migrate(
  options: WorkerSharedOptions,
  client: PoolClient,
) {
  const { escapedWorkerSchema, logger } = processSharedOptions(options);
  let latestMigration: number | null = null;
  let latestBreakingMigration: number | null = null;
  for (let attempts = 0; attempts < 2; attempts++) {
    try {
      const {
        rows: [row],
      } = await client.query(
        `select current_setting('server_version_num') as server_version_num,
        (select id from ${escapedWorkerSchema}.migrations order by id desc limit 1) as id,
        (select id from ${escapedWorkerSchema}.migrations where breaking is true order by id desc limit 1) as biggest_breaking_id;`,
      );

      latestMigration = row.id;
      latestBreakingMigration = row.biggest_breaking_id;
      checkPostgresVersion(row.server_version_num);
    } catch (e) {
      if (attempts === 0 && (e.code === "42P01" || e.code === "42703")) {
        await installSchema(options, client);
      } else {
        throw e;
      }
    }
  }

  const migrationFiles = Object.keys(migrations) as (keyof typeof migrations)[];
  let highestMigration = 0;
  let migrated = false;
  for (const migrationFile of migrationFiles) {
    const migrationNumber = parseInt(migrationFile.slice(0, 6), 10);
    if (migrationNumber > highestMigration) {
      highestMigration = migrationNumber;
    }
    if (latestMigration == null || migrationNumber > latestMigration) {
      migrated = true;
      await runMigration(options, client, migrationFile, migrationNumber);
    }
  }

  if (migrated) {
    logger.debug(`Migrations complete`);
  }

  if (latestBreakingMigration && highestMigration < latestBreakingMigration) {
    process.exitCode = 57;
    throw new Error(
      `Database is using Graphile Worker schema revision ${latestMigration} which includes breaking migration ${latestBreakingMigration}, but the currently running worker only supports up to revision ${highestMigration}. It would be unsafe to continue; please ensure all versions of Graphile Worker are compatible.`,
    );
  } else if (latestMigration && highestMigration < latestMigration) {
    logger.warn(
      `Database is using Graphile Worker schema revision ${latestMigration}, but the currently running worker only supports up to revision ${highestMigration} which may or may not be compatible. Please ensure all versions of Graphile Worker you're running are compatible, or use Worker Pro which will perform this check for you. Attempting to continue regardless.`,
    );
  }
}
