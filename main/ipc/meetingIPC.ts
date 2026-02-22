import { ipcMain, BrowserWindow } from 'electron';
import { writePCM } from '../speech/streamingSTT';



export function registerMeetingIPC(win: BrowserWindow) {
ipcMain.on('audio:pcm', (_, buffer: Buffer) => {
  writePCM(buffer);
});

}
