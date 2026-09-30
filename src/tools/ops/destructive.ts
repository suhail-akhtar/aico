/**
 * Which remote commands a person must see before they run.
 *
 * The ops tools run with a credential the agent can use unattended — that is
 * the point of them — so what stands between a confused or prompt-injected
 * model and `rm -rf /var/lib/postgresql` on the owner's server is this list.
 * A hit does not refuse the command: it forces an every-use approval through
 * the credential broker (`requireApproval`), so the person sees the exact
 * command text, with `{{secret:…}}` references and never values, and says yes
 * or no. Nothing the model passes can skip that — there is deliberately no
 * "I know it is destructive" argument.
 *
 * What counts: deleting data (recursive deletes, dropping databases, wiping
 * disks, destroying volumes), stopping or removing services and containers,
 * power actions, and anything that can lock the operator out — firewall rule
 * changes, SSH daemon config and restarts, locking or deleting accounts,
 * sudoers edits.
 *
 * Honest limit: this is pattern matching over command text. A command that
 * builds `rm` at runtime (`$(printf rm) -rf /`) is not seen, exactly like the
 * Bash safety classifier. It is a second line behind the owner scoping the
 * credential, not a sandbox — docs/security/ops-tools.md says so.
 *
 * @module tools/ops/destructive
 */

export interface DestructiveVerdict {
  destructive: boolean;
  /** Short reasons, in the order found, for the approval text. */
  reasons: string[];
}

const RULES: Array<{ re: RegExp; reason: string }> = [
  // Deleting data
  { re: /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/, reason: 'recursive delete' },
  { re: /\brm\s+-[a-zA-Z]*f[a-zA-Z]*\s+[^|;&]*[*?]/, reason: 'forced delete of a wildcard' },
  { re: /\bfind\b[^|;&]*\s-delete\b/, reason: 'find -delete' },
  { re: /\bshred\b|\bwipefs\b|\bblkdiscard\b/, reason: 'wiping data' },
  { re: /\bmkfs(?:\.\w+)?\b|\bmke2fs\b|\bFormat-Volume\b|\bClear-Disk\b|\bInitialize-Disk\b|\bformat\s+[a-z]:/i, reason: 'formatting a disk' },
  { re: /\bdd\b[^|;&]*\bof=\/dev\//, reason: 'raw write to a device' },
  { re: />\s*\/dev\/(?:sd|nvme|vd|xvd|hd|mmcblk)/, reason: 'overwriting a device' },
  { re: /\b(?:fdisk|sfdisk|sgdisk|parted|gdisk)\b|\bRemove-Partition\b/i, reason: 'changing partitions' },
  { re: /\b(?:lvremove|vgremove|pvremove)\b|\bzpool\s+(?:destroy|labelclear)\b|\bzfs\s+destroy\b/, reason: 'destroying a volume' },
  { re: /\btruncate\s+(?:-s\s*0|--size[= ]0)\b/, reason: 'truncating a file to zero' },
  { re: /\bRemove-Item\b[^|;]*-Recurse\b|\brd\s+\/s\b|\brmdir\s+\/s\b|\bdel\s+\/[sq]\b/i, reason: 'recursive delete' },
  // Databases
  { re: /\bdrop\s+(?:database|schema|table|user|role)\b/i, reason: 'dropping a database object' },
  { re: /\btruncate\s+(?:table\s+)?[`"\w.]+\s*;?/i, reason: 'truncating a table', },
  { re: /\bdelete\s+from\s+[`"\w.]+\s*(?:;|$|")/i, reason: 'deleting every row of a table' },
  { re: /\bdropdb\b|\bdropuser\b|\bmysqladmin\b[^|;&]*\bdrop\b/, reason: 'dropping a database' },
  { re: /\bredis-cli\b[^|;&]*\bflush(?:all|db)\b|\bFLUSHALL\b/i, reason: 'flushing a datastore' },
  { re: /\bdb\.dropDatabase\(|\.drop\(\)/, reason: 'dropping a database' },
  // Services, containers, clusters
  { re: /\bsystemctl\s+(?:[-\w]+\s+)*(?:stop|disable|mask|kill|isolate)\b/, reason: 'stopping or disabling a service' },
  { re: /\bservice\s+\S+\s+stop\b|\/etc\/init\.d\/\S+\s+stop\b|\brc-service\s+\S+\s+stop\b/, reason: 'stopping a service' },
  { re: /\bStop-Service\b|\bSet-Service\b[^|;]*-StartupType\s+Disabled\b|\bsc(?:\.exe)?\s+(?:stop|delete)\b/i, reason: 'stopping a service' },
  { re: /\bdocker\s+(?:container\s+)?(?:stop|kill|rm|rmi)\b|\bdocker\s+(?:system|volume|image|container|network)\s+(?:prune|rm)\b|\bdocker[- ]compose\b[^|;&]*\b(?:down|rm|kill|stop)\b/, reason: 'stopping or removing containers' },
  { re: /\bkubectl\s+(?:delete|drain|cordon|scale\b[^|;&]*--replicas[= ]0)\b|\bhelm\s+(?:uninstall|delete)\b/, reason: 'removing cluster resources' },
  { re: /\bkill\s+-(?:9|KILL)\s+1\b|\bkillall\b|\bpkill\b/, reason: 'killing processes' },
  // Power
  { re: /\b(?:reboot|shutdown|poweroff|halt)\b|\binit\s+[06]\b|\bRestart-Computer\b|\bStop-Computer\b/i, reason: 'rebooting or shutting down' },
  // Lock-out risks
  { re: /\biptables\b[^|;&]*\s-(?:[FXPADIRZN]|-flush|-policy|-append|-insert|-delete)\b|\bip6tables\b[^|;&]*\s-[FXPADIR]\b/, reason: 'changing firewall rules (can lock you out)' },
  { re: /\bnft\s+(?:add|delete|flush|insert|replace|-f)\b/, reason: 'changing firewall rules (can lock you out)' },
  { re: /\bufw\s+(?:enable|deny|reject|reset|default|delete|limit)\b/, reason: 'changing firewall rules (can lock you out)' },
  { re: /\bfirewall-cmd\b[^|;&]*--(?:remove|set-default-zone|panic-on|reload|add-rich-rule|permanent)/, reason: 'changing firewall rules (can lock you out)' },
  { re: /\bnetsh\s+(?:adv)?firewall\b|\b(?:Set|New|Remove|Disable)-NetFirewall\w*\b/i, reason: 'changing firewall rules (can lock you out)' },
  { re: /\/etc\/ssh\/sshd_config|\bsshd_config\.d\b/, reason: 'changing the SSH daemon config (can lock you out)' },
  { re: /\bsystemctl\s+(?:restart|reload|stop)\s+(?:ssh|sshd)\b|\bservice\s+sshd?\s+(?:restart|stop)\b/, reason: 'restarting SSH (can lock you out)' },
  { re: /\b(?:userdel|deluser|delgroup|groupdel)\b|\bRemove-LocalUser\b/i, reason: 'deleting an account' },
  { re: /\bpasswd\s+-[a-zA-Z]*[ld]\b|\busermod\s+[^|;&]*-(?:L|-lock|-expiredate)\b|\bchage\s+[^|;&]*-E\s*0\b/, reason: 'locking an account (can lock you out)' },
  { re: /\/etc\/sudoers|\bvisudo\b/, reason: 'changing sudoers (can lock you out)' },
  { re: /\bcrontab\s+-r\b/, reason: 'removing all cron jobs' },
  // Packages and permissions at scale
  { re: /\b(?:apt|apt-get|aptitude)\s+(?:-\S+\s+)*(?:remove|purge|autoremove)\b|\b(?:yum|dnf|zypper)\s+(?:-\S+\s+)*(?:remove|erase)\b|\bapk\s+del\b|\bpacman\s+-R/, reason: 'removing packages' },
  { re: /\bchmod\s+-R\s+[0-7]*7[0-7]{0,2}\s+\/(?:\s|$)|\bchown\s+-R\s+\S+\s+\/(?:\s|$)/, reason: 'changing ownership or permissions of /' },
];

/** Normalise enough that `sudo`, quoting and line continuations do not hide a command. */
function normalise(command: string): string {
  return command
    .replace(/\\\r?\n/g, ' ')
    .replace(/(?<![\\])["']/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Classify a command meant for a remote shell (POSIX or PowerShell). Pure. */
export function classifyRemoteCommand(command: string): DestructiveVerdict {
  const text = normalise(command);
  const reasons: string[] = [];
  for (const { re, reason } of RULES) {
    if (re.test(text) && !reasons.includes(reason)) reasons.push(reason);
  }
  return { destructive: reasons.length > 0, reasons };
}

/** HTTP methods that remove things, and therefore need a person. */
export function isDestructiveHttpMethod(method: string): boolean {
  return method.toUpperCase() === 'DELETE';
}
