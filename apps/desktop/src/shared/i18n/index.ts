import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// Import English translation resources
import enCommon from './locales/en/common.json';
import enNavigation from './locales/en/navigation.json';
import enSettings from './locales/en/settings.json';
import enTasks from './locales/en/tasks.json';
import enWelcome from './locales/en/welcome.json';
import enOnboarding from './locales/en/onboarding.json';
import enDialogs from './locales/en/dialogs.json';
import enGitlab from './locales/en/gitlab.json';
import enTaskReview from './locales/en/taskReview.json';
import enTerminal from './locales/en/terminal.json';
import enErrors from './locales/en/errors.json';
import enDeploy from './locales/en/deploy.json';

// Import Ukrainian translation resources
import ukCommon from './locales/uk/common.json';
import ukNavigation from './locales/uk/navigation.json';
import ukSettings from './locales/uk/settings.json';
import ukTasks from './locales/uk/tasks.json';
import ukWelcome from './locales/uk/welcome.json';
import ukOnboarding from './locales/uk/onboarding.json';
import ukDialogs from './locales/uk/dialogs.json';
import ukGitlab from './locales/uk/gitlab.json';
import ukTaskReview from './locales/uk/taskReview.json';
import ukTerminal from './locales/uk/terminal.json';
import ukErrors from './locales/uk/errors.json';
import ukDeploy from './locales/uk/deploy.json';

export const defaultNS = 'common';

export const resources = {
  en: {
    common: enCommon,
    navigation: enNavigation,
    settings: enSettings,
    tasks: enTasks,
    welcome: enWelcome,
    onboarding: enOnboarding,
    dialogs: enDialogs,
    gitlab: enGitlab,
    taskReview: enTaskReview,
    terminal: enTerminal,
    errors: enErrors,
    deploy: enDeploy
  },
  uk: {
    common: ukCommon,
    navigation: ukNavigation,
    settings: ukSettings,
    tasks: ukTasks,
    welcome: ukWelcome,
    onboarding: ukOnboarding,
    dialogs: ukDialogs,
    gitlab: ukGitlab,
    taskReview: ukTaskReview,
    terminal: ukTerminal,
    errors: ukErrors,
    deploy: ukDeploy
  }
} as const;

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: 'en', // Default language (will be overridden by settings)
    fallbackLng: 'en',
    supportedLngs: ['en', 'uk'],
    defaultNS,
    ns: ['common', 'navigation', 'settings', 'tasks', 'welcome', 'onboarding', 'dialogs', 'gitlab', 'taskReview', 'terminal', 'errors', 'deploy'],
    interpolation: {
      escapeValue: false // React already escapes values
    },
    react: {
      useSuspense: false // Disable suspense for Electron compatibility
    }
  });

export default i18n;
