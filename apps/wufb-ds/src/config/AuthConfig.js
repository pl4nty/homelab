import { LogLevel } from "@azure/msal-browser"; //MIT LICENSE < https://github.com/AzureAD/microsoft-authentication-library-for-js >

export const msalConfig = {
  auth: {
    clientId: "0fa38708-b7d4-4600-bc07-2b1b6a329e4e", // e.g. "70258689-8a4e-410f-a300-cb2011f23cf3"
    redirectUri: "https://wufb-ds.tplant.com.au" // e.g. "http://localhost:8080"
  },
  cache: {
    cacheLocation: "sessionStorage",
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) {
          return;
        }
        switch (level) {
          case LogLevel.Error:
            console.error(message);
            return;
        }
      },
    },
  },
};

export const wufbRequest = {
  scopes: [
    "00000003-0000-0000-c000-000000000000/WindowsUpdates.ReadWrite.All",
    "User.Read",
  ],
  prompt: "select_account"
};

export const userFeedbackRequest = {
  scopes: ["User.Read"],
};
