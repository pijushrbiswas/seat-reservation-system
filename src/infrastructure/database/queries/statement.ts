/** A SQL text with a stable name. node-postgres prepares a named statement once per connection and reuses its plan, saving parse and plan work in Postgres. */
export interface Statement {
  name: string;
  text: string;
}

/**
 * Names a query so it is prepared once per connection. The name must be unique across the application.
 * @param name - Unique statement name.
 * @param text - The SQL.
 */
export const prepared = (name: string, text: string): Statement => ({ name, text });
