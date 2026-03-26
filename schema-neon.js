const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://neondb_owner:npg_3rALPVHRX5kd@ep-still-breeze-ang127cc-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
});

async function main() {
  await client.connect();
  
  // Get tables
  const tables = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    ORDER BY table_name
  `);
  console.log('=== TABLAS ===');
  tables.rows.forEach(t => console.log(t.table_name));
  
  // Get columns for each table
  for (const t of tables.rows) {
    const cols = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = $1
      ORDER BY ordinal_position
    `, [t.table_name]);
    console.log(`\n=== ${t.table_name} ===`);
    cols.rows.forEach(c => console.log(`  ${c.column_name} | ${c.data_type} | ${c.is_nullable} | ${c.column_default}`));
  }
  
  await client.end();
}

main().catch(console.error);