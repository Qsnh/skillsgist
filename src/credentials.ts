import { randomHex } from "./auth";

export const INSTALL_KEY_PREFIX = "sgi_";
export const DEVICE_TOKEN_PREFIX = "sgd_";

export const newInstallKey = () => `${INSTALL_KEY_PREFIX}${randomHex(32)}`;
