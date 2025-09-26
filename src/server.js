import express from "express";

export function startServer() {
  const app = express();
  const PORT = process.env.PORT || 10000;
  app.get("/", (req, res) => res.send("Bridge is running 🚀"));
  app.listen(PORT, () => console.log(`🌐 Server listening on ${PORT}`));
}
