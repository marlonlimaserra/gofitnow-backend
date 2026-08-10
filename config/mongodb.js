const { MongoClient } = require("mongodb");

// The backend's single connection source. The .env carries only MONGODB_URI —
// the database name comes from the URI itself (mongodb://host:port/<db>), so
// switching databases means switching the URI, with no code change.
const connectionString = process.env.MONGODB_URI;

if (!connectionString) {
  console.error("[mongo] MONGODB_URI is not set in .env");
  process.exit(1);
}

// Short serverSelectionTimeoutMS: with a local Mongo down, the 30s default
// would hang the boot for half a minute before stating the obvious.
const client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 8000 });

let dbConnection;
let connecting;

module.exports = {
  // Always returns the SAME db instance. The first call opens the connection;
  // concurrent ones await the same promise (hence `connecting`), otherwise N
  // simultaneous requests at boot would open N connections.
  connectToServer: async function () {
    if (dbConnection) return dbConnection;

    if (!connecting) {
      connecting = client
        .connect()
        .then((c) => {
          // db() with no argument uses the database from the URI.
          dbConnection = c.db();
          console.log("[mongo] connected to " + dbConnection.databaseName);
          return dbConnection;
        })
        .catch((err) => {
          connecting = undefined;
          console.error("[mongo] connection failed:", err.message);
          throw err;
        });
    }

    return connecting;
  },

  close: async function () {
    await client.close();
    dbConnection = undefined;
    connecting = undefined;
  },
};
