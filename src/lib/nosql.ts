/** Queries to open for a Redis key or a MongoDB collection clicked in the sidebar. */

/** A key as one redis-cli argument: plain when it can be, else double-quoted. */
export function redisArg(value: string): string {
  return /^[\w:.\-/@{}|]+$/.test(value) ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The read command that shows a key of this type (from TYPE), first 100 items for collections. */
export function redisReadCommand(key: string, type: string | null): string {
  const k = redisArg(key);
  switch (type) {
    case "hash":
      return `HGETALL ${k}`;
    case "list":
      return `LRANGE ${k} 0 99`;
    case "set":
      return `SSCAN ${k} 0 COUNT 100`;
    case "zset":
      return `ZRANGE ${k} 0 99 WITHSCORES`;
    case "stream":
      return `XRANGE ${k} - + COUNT 100`;
    case "string":
      return `GET ${k}`;
    default:
      return `TYPE ${k}`;
  }
}

/** `db.users.find({})`, or `db.getCollection("…")` for names that aren't identifiers. */
export function mongoCollection(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? `db.${name}` : `db.getCollection(${JSON.stringify(name)})`;
}

export const mongoFind = (name: string) => `${mongoCollection(name)}.find({}).limit(100)`;

/** The collection a `find` reads (only then are its documents the stored ones, so editable). */
export function findCollection(sql: string): string | null {
  const m = /db\s*(?:\.\s*getCollection\(\s*(["'])(.+?)\1\s*\)|\[\s*(["'])(.+?)\3\s*\]|\.\s*([A-Za-z_$][\w$]*))\s*\.\s*(find|findOne)\s*\(/.exec(sql);
  return m ? (m[2] ?? m[4] ?? m[5] ?? null) : null;
}

/**
 * An edit as $set / $unset of the top-level fields that changed, so fields left alone keep
 * their exact BSON types (the editor shows them as plain JSON). Null when nothing changed.
 */
export function updateFor(before: Record<string, unknown>, after: Record<string, unknown>): string | null {
  const set: Record<string, unknown> = {};
  const unset: Record<string, string> = {};
  for (const [k, v] of Object.entries(after)) if (k !== "_id" && JSON.stringify(v) !== JSON.stringify(before[k])) set[k] = v;
  for (const k of Object.keys(before)) if (k !== "_id" && !(k in after)) unset[k] = "";
  const parts = [Object.keys(set).length ? `"$set": ${JSON.stringify(set)}` : "", Object.keys(unset).length ? `"$unset": ${JSON.stringify(unset)}` : ""].filter(Boolean);
  return parts.length ? `{ ${parts.join(", ")} }` : null;
}
