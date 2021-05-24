import fs from 'fs';
import { logDebug } from './debug';

/**
 * Save file by path with any data
 * @param path file path to save
 * @param data any data convertable to string
 */
export function saveFile(path: string, data: any) {
    try {
        fs.writeFileSync(path, JSON.stringify(data));
    } catch (e) {
        logDebug('File saving error', path, e);
    }
}

/**
 * Check file path exists, and recoursive create requested path if needed
 * @param path file path
 */
export function ensureFile(path: string) {
    try {
        if (!fs.existsSync(path)) {
            const folderPath = path.substring(0, path.lastIndexOf('/'));
            fs.mkdirSync(folderPath, { recursive: true });
            fs.writeFileSync(path, '', { flag: 'wx' });
        }
    } catch (e) {
        logDebug('Ensure file error', path, e);
    }
}

/**
 * Read file content as string in utf-8 encode
 * @param path file path
 */
export function readFile(path: string) {
    try {
        // Если файла еще нет ничего не делаем
        if (!fs.existsSync(path)) {
            return null;
        }

        return fs.readFileSync(path, 'utf-8');
    } catch (e) {
        logDebug('Read file error', path, e);
    }

    return null;
}

/**
 * Check is directory by path
 * @param path directory path
 */
export function isDir(path: string) {
    try {
        const stat = fs.lstatSync(path);
        return stat.isDirectory();
    } catch (e) {
        // lstatSync throws an error if path doesn't exist
        return false;
    }
}
