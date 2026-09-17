// pm2 process definition for the daily blocklist sync.
module.exports = {
  apps: [
    {
      name: 'cf-blocklist-sync',
      script: 'run_sync.js',
      cwd: __dirname,
      cron_restart: '0 12 * * *', // daily at 12:00 local time (Asia/Kuala_Lumpur)
      // One-shot app: a clean exit(0) must stop (wait for next cron tick),
      // while a failed run (non-zero exit) retries after restart_delay.
      stop_exit_codes: [0],
      min_uptime: 0,
      restart_delay: 3000,
      merge_logs: true,
      time: true,
      out_file: '/var/log/cf_sync.log',
      error_file: '/var/log/cf_sync.err',
    },
  ],
};
