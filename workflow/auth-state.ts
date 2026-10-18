import type { WebDriver } from "selenium-webdriver";

export interface AuthState {
  loginForm: boolean;
  rejected: boolean;
  authenticated: boolean;
}

export async function readAuthState(driver: WebDriver): Promise<AuthState> {
  return driver.executeScript<AuthState>(`
    const body = document.body?.innerText || '';
    return {
      loginForm: !!document.querySelector('input[name="username"]') && !!document.querySelector('input[name="password"]'),
      rejected: /incorrect username\\s*\\/\\s*password combination|account is currently locked/i.test(body),
      authenticated: !!document.querySelector('a[href*="Logout"]')
    };
  `);
}
