/**
 * Thin client for Dietly's (undocumented) internal JSON API.
 * Reverse-engineered from the panel.dietly.pl / dietly.pl SPA — see docs/dietly-api.md.
 * Auth is a cookie session; every call needs the company-id + x-launcher-type headers.
 */

const PANEL = 'https://panel.dietly.pl/api';
const API = 'https://dietly.pl/api';

export interface OrderSummary {
  orderId: number;
  status: string;
  dateFrom: string;
  dateTo: string;
  companyName: string;
  dietName: string;
  dietCalories: number;
}

export interface DeliveryMealRef {
  deliveryMealId: number;
  dietCaloriesMealId: number;
  amount: number;
  deleted: boolean;
}

export interface Delivery {
  deliveryId: number;
  date: string; // YYYY-MM-DD
  deleted: boolean;
  deliveryMeals: DeliveryMealRef[];
}

export interface Ingredient {
  name: string;
  major: boolean;
}

/** A meal currently chosen for a slot on a given day. */
export interface MenuMeal {
  mealName: string; // slot label: Śniadanie / II Śniadanie / Obiad / Podwieczorek / Kolacja
  menuMealName: string; // the dish
  deliveryMealId: number; // stable slot id (constant across switches)
  dietCaloriesMealId: number; // identifies the chosen variant
  switchable: boolean;
  allergens: string[];
  ingredients: Ingredient[];
  kcal: number | null;
  image: string | null;
}

/** A candidate the slot can be switched to. */
export interface SwitchOption {
  dietOptionName: string; // SPORT / OPTIMAL / SLIM / NISKI IG / WEGE ...
  canBeChanged: boolean;
  mealName: string;
  menuMealName: string;
  dietCaloriesMealId: number; // target id passed to the swap PUT
  allergens: string[];
  ingredients: Ingredient[];
  kcal: number | null;
  image: string | null;
}

function ingredients(raw: unknown): Ingredient[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((i): Ingredient => ({ name: String(i?.name ?? ''), major: Boolean(i?.major) }))
    .filter((i) => i.name);
}

function kcalOf(nutrition: unknown): number | null {
  const n = nutrition as { calories?: number; kcal?: number } | undefined;
  const v = n?.calories ?? n?.kcal;
  return typeof v === 'number' ? Math.round(v) : null;
}

function normalizeMenuMeal(m: any): MenuMeal {
  return {
    mealName: String(m.mealName ?? '').replace('II śniadanie', 'II Śniadanie'),
    menuMealName: String(m.menuMealName ?? m.mealName ?? ''),
    deliveryMealId: Number(m.deliveryMealId),
    dietCaloriesMealId: Number(m.dietCaloriesMealId),
    switchable: Boolean(m.switchable),
    allergens: Array.isArray(m.allergens) ? m.allergens.map(String) : [],
    ingredients: ingredients(m.ingredients),
    kcal: kcalOf(m.nutrition),
    image: m.menuMealImageUrl ? String(m.menuMealImageUrl) : null,
  };
}

function normalizeOption(o: any): SwitchOption {
  const d = o.menuMealDetails ?? {};
  return {
    dietOptionName: String(o.dietOptionName ?? ''),
    canBeChanged: o.canBeChanged !== false,
    mealName: String(d.mealName ?? o.mealName ?? '').replace('II śniadanie', 'II Śniadanie'),
    menuMealName: String(d.menuMealName ?? ''),
    dietCaloriesMealId: Number(d.dietCaloriesMealId),
    allergens: Array.isArray(d.allergens) ? d.allergens.map(String) : [],
    ingredients: ingredients(d.ingredients),
    kcal: kcalOf(d.nutrition),
    image: d.image ? String(d.image) : null,
  };
}

export class DietlyClient {
  private cookies = new Map<string, string>();
  private readonly companyId: string;

  constructor(companyId: string) {
    this.companyId = companyId;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      accept: 'application/json',
      'company-id': this.companyId,
      'x-launcher-type': 'BROWSER_DIETLY',
      ...extra,
    };
    if (this.cookies.size) {
      h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    return h;
  }

  private storeCookies(res: Response): void {
    const setCookie = (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const c of setCookie) {
      const pair = c.split(';')[0] ?? '';
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, {
      ...init,
      headers: this.headers(init.headers as Record<string, string>),
      redirect: 'manual',
    });
    this.storeCookies(res);
    return res;
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await this.request(url);
    if (!res.ok) throw new HttpError(res.status, `GET ${url}`, await res.text());
    return (await res.json()) as T;
  }

  async login(email: string, password: string): Promise<void> {
    const res = await this.request(`${PANEL}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: email, password }).toString(),
    });
    if (res.status >= 400) {
      throw new HttpError(res.status, 'login', await res.text());
    }
    // Confirm the session actually works.
    await this.getJson(`${API}/profile`);
  }

  async getActiveOrders(): Promise<OrderSummary[]> {
    const data = await this.getJson<{ results?: OrderSummary[] }>(
      `${API}/profile/profile-order/all?page=0`,
    );
    return (data.results ?? []).filter((o) => o.status === 'ACTIVE');
  }

  async getOrder(orderId: number): Promise<{ deliveries: Delivery[] }> {
    return this.getJson(`${API}/company/customer/order/${orderId}`);
  }

  async getDayMenu(deliveryId: number): Promise<MenuMeal[]> {
    const data = await this.getJson<{ deliveryMenuMeal?: unknown[] }>(
      `${API}/company/general/menus/delivery/${deliveryId}/new`,
    );
    return (data.deliveryMenuMeal ?? []).map(normalizeMenuMeal);
  }

  async getSwitchOptions(
    orderId: number,
    deliveryId: number,
    deliveryMealId: number,
  ): Promise<SwitchOption[]> {
    const data = await this.getJson<{ mealChangeOptions?: unknown[] }>(
      `${API}/company/customer/order/${orderId}/deliveries/${deliveryId}/delivery-meals/${deliveryMealId}/switch`,
    );
    return (data.mealChangeOptions ?? []).map(normalizeOption);
  }

  async swapMeal(
    orderId: number,
    deliveryId: number,
    deliveryMealId: number,
    dietCaloriesMealId: number,
    amount = 1,
  ): Promise<void> {
    const url =
      `${API}/company/customer/order/${orderId}/deliveries/${deliveryId}` +
      `/delivery-meals/${deliveryMealId}/switch?amount=${amount}&dietCaloriesMealId=${dietCaloriesMealId}`;
    const res = await this.request(url, { method: 'PUT' });
    if (!res.ok) throw new HttpError(res.status, 'swap', await res.text());
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly where: string;
  readonly body: string;

  constructor(status: number, where: string, body: string) {
    super(`${where} → HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.where = where;
    this.body = body;
  }
}
