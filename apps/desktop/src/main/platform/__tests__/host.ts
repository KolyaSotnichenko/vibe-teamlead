/**
 * The machine the tests run on, for tests that can only run on some hosts
 * (a fake tool written as a sh script, POSIX file modes). App code asks
 * platform/ instead; tests of a Windows code path pass the platform in.
 */
export const isWindowsHost = process.platform === 'win32';
