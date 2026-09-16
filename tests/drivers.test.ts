import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SqliteStore, PgStore, MysqlStore, createStore } from '../src/store.js';

describe('Database drivers and DDL', () => {
  it('has valid SQL DDL files for sqlite, pg, and mysql in src/sql', () => {
    const sqlDir = path.resolve(process.cwd(), 'src/sql');
    expect(fs.existsSync(path.join(sqlDir, 'sqlite.sql'))).toBe(true);
    expect(fs.existsSync(path.join(sqlDir, 'pg.sql'))).toBe(true);
    expect(fs.existsSync(path.join(sqlDir, 'mysql.sql'))).toBe(true);

    const sqliteSql = fs.readFileSync(path.join(sqlDir, 'sqlite.sql'), 'utf8');
    const pgSql = fs.readFileSync(path.join(sqlDir, 'pg.sql'), 'utf8');
    const mysqlSql = fs.readFileSync(path.join(sqlDir, 'mysql.sql'), 'utf8');

    // Check key tables exist in all DDLs
    for (const table of ['upstreams', 'credentials', 'credential_bindings', 'sessions', 'login_attempts', 'notification_history', 'system_settings']) {
      expect(sqliteSql).toContain(table);
      expect(pgSql).toContain(table);
      expect(mysqlSql).toContain(table);
    }

    // Dialect-specific keywords
    expect(pgSql).toContain('SERIAL PRIMARY KEY');
    expect(mysqlSql).toContain('AUTO_INCREMENT PRIMARY KEY');
    expect(mysqlSql).toContain('ENGINE=InnoDB');
  });

  it('initializes PgStore and executes pg.sql schema', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const store = new PgStore({}, 'test-encryption-key');
    (store as any).pool = {
      query: mockQuery,
      connect: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined)
    };

    await store.init();
    expect(mockQuery).toHaveBeenCalled();
    const querySql = mockQuery.mock.calls[0][0];
    expect(querySql).toContain('CREATE TABLE IF NOT EXISTS upstreams');

    await store.close();
  });

  it('initializes MysqlStore and executes mysql.sql schema', async () => {
    const mockQuery = vi.fn().mockResolvedValue([[]]);
    const store = new MysqlStore({}, 'test-encryption-key');
    (store as any).pool = {
      query: mockQuery,
      getConnection: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined)
    };

    await store.init();
    expect(mockQuery).toHaveBeenCalled();
    const querySql = mockQuery.mock.calls[0][0];
    expect(querySql).toContain('CREATE TABLE IF NOT EXISTS upstreams');

    await store.close();
  });

  it('createStore factory handles postgres and mysql types', async () => {
    // Test postgres branch instantiation
    const pgInitSpy = vi.spyOn(PgStore.prototype, 'init').mockResolvedValue(undefined);
    const pgCloseSpy = vi.spyOn(PgStore.prototype, 'close').mockResolvedValue(undefined);

    const pgStore = await createStore({
      type: 'postgres',
      url: 'postgres://user:pass@localhost:5432/testdb',
      encryptionKey: 'test-key'
    });
    expect(pgStore).toBeInstanceOf(PgStore);
    expect(pgInitSpy).toHaveBeenCalled();
    await pgStore.close();
    expect(pgCloseSpy).toHaveBeenCalled();
    pgInitSpy.mockRestore();
    pgCloseSpy.mockRestore();

    // Test mysql branch instantiation
    const mysqlInitSpy = vi.spyOn(MysqlStore.prototype, 'init').mockResolvedValue(undefined);
    const mysqlCloseSpy = vi.spyOn(MysqlStore.prototype, 'close').mockResolvedValue(undefined);

    const mysqlStore = await createStore({
      type: 'mysql',
      url: 'mysql://user:pass@localhost:3306/testdb',
      encryptionKey: 'test-key'
    });
    expect(mysqlStore).toBeInstanceOf(MysqlStore);
    expect(mysqlInitSpy).toHaveBeenCalled();
    await mysqlStore.close();
    expect(mysqlCloseSpy).toHaveBeenCalled();
    mysqlInitSpy.mockRestore();
    mysqlCloseSpy.mockRestore();
  });
});
