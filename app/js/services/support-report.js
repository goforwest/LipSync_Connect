// One-action support artifact: collect the device's current settings when a
// session exists, then combine that transcript with app/device versions and
// the full session log. The report remains useful while disconnected and its
// builder applies the same device-identifier redaction as detailed log export.
import { $ } from '../ui/dom.js';
import { showConfirm } from '../ui/formatting.js';
import { showNotification } from '../ui/notification.js';
import { announceStatus } from '../ui/a11y.js';
import { sendCommand, waitLine } from '../serial/commands.js';
import { serialSession } from '../serial/session.js';
import { buildSupportReport, downloadLogFile, shareTextFile } from './log-export.js';
import { log } from './log.js';

const DUMP_TIMEOUT_MS = 8000;

async function collectSettingsDump() {
  if (!serialSession.port) return 'Not captured (no LipSync connected)';
  const controller = new AbortController();
  const endLine = waitLine((line) => /^SUCCESS,\d+:EX,0:END$/.test(line), DUMP_TIMEOUT_MS, controller.signal);
  try {
    await sendCommand('EX,0:0');
    await endLine;
    return 'Included in the session log';
  } catch (error) {
    controller.abort();
    await endLine.catch(() => {});
    log('Support report settings dump could not complete: ' + error.message, 'log-err');
    return 'Could not be captured (' + error.message + ')';
  }
}

export async function createSupportReport() {
  const dumpStatus = await collectSettingsDump();
  // Paired-host names are user content: they ship only when the report's
  // option is ticked (the checkbox itself explains why it is off by default).
  const includeBtHosts = !!$('reportIncludeBtHosts')?.checked;
  log('Support report created. Device identifiers are redacted.', 'log-info');
  return buildSupportReport({ dumpStatus, includeBtHosts });
}

export function bindSupportReport() {
  const download = $('btnDownloadSupportReport');
  const share = $('btnShareSupportReport');
  const status = $('supportReportStatus');
  if (!download || !share) return;

  const setBusy = (busy, message = '') => {
    download.disabled = busy;
    share.disabled = busy;
    if (status) status.textContent = message;
  };
  const run = async (mode) => {
    setBusy(true, serialSession.port ? 'Collecting device settings…' : 'Creating report from this session…');
    announceStatus('Creating support report…');
    try {
      const report = await createSupportReport();
      if (mode === 'download') {
        downloadLogFile(report);
        setBusy(false, 'Support report downloaded.');
        announceStatus('Support report downloaded.');
      } else {
        const confirmFallback = () =>
          showConfirm(
            'Share support report',
            'Share this support report by email or clipboard? It contains device settings and session events. Device identifiers are removed.',
          );
        await shareTextFile(report, confirmFallback, {
          title: 'LipSync Connect support report',
          noun: 'support report',
        });
        setBusy(false, 'Support report is ready.');
      }
    } catch (error) {
      setBusy(false, 'The support report could not be created.');
      log('Support report failed: ' + error.message, 'log-err');
      showNotification('The support report could not be created. Try again or download the detailed log.', true);
      announceStatus('The support report could not be created.');
    }
  };

  download.addEventListener('click', () => void run('download'));
  share.addEventListener('click', () => void run('share'));
}
