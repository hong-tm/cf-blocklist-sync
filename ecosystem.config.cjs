// pm2 process definition for the daily blocklist sync (the production
// scheduler on this host). A systemd timer variant also exists there, disabled.
module.exports = {
  apps: [
    {
      name: 'cf-blocklist-sync',
      script: 'run_sync.js',
      cwd: __dirname,
      cron_restart: '0 12 * * *', // daily at 12:00 local time (Asia/Kuala_Lumpur)
      // One-shot app: a clean exit(0) must stop (wait for next cron tick),
      // while a failed run (non-zero exit) retries after restart_delay.
      // A failing run lasts well under min_uptime, so pm2 counts every retry
      // as unstable and stops after max_restarts (no infinite 3-second loop);
      // the next cron tick starts a fresh cycle.
      stop_exit_codes: [0],
      min_uptime: '1m',
      max_restarts: 3,
      restart_delay: 300000,
      merge_logs: true,
      time: true,
      out_file: '/var/log/cf_sync.log',
      error_file: '/var/log/cf_sync.err',
    },
  ],
};
