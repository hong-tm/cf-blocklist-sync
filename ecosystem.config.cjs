// pm2 process definition for the daily blocklist sync (the production
// scheduler on this host). A systemd timer variant also exists there, disabled.
module.exports = {
  apps: [
    {
      name: 'cf-blocklist-sync',
      script: 'run_sync.js',
      cwd: __dirname,
      cron_restart: '0 12 * * *', // daily at 12:00 local time (Asia/Kuala_Lumpur)
      // One-shot: run at the cron tick, exit, stay down until the next tick.
      // Never let pm2 auto-restart: the retry budget lives in run_sync.js,
      // which counts every failed run (a supervisor's min_uptime heuristic
      // would only bound fast crashes, not runs that fail after minutes).
      autorestart: false,
      merge_logs: true,
      time: true,
      out_file: '/var/log/cf_sync.log',
      error_file: '/var/log/cf_sync.err',
    },
  ],
};
