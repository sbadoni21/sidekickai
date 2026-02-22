import { app, BrowserWindow } from 'electron';
import { startStreamingSTT } from './speech/streamingSTT';
import { registerMeetingIPC } from './ipc/meetingIPC';

let win: BrowserWindow;

app.whenReady().then(() => {
  win = new BrowserWindow({
    webPreferences: {
      preload: __dirname + '/preload.js',
    },
  });

  win.loadURL('http://localhost:5180');

  startStreamingSTT(win);
  registerMeetingIPC(win);
});
