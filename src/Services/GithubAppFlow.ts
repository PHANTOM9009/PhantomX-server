import express from "express";
import type { Request, Response } from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import fetch from "node-fetch";
import jwt from "jsonwebtoken";
import { spawnSync } from "child_process";
import * as dotenv from 'dotenv';
import fs from 'fs';
import {Octokit} from "@octokit/rest";


dotenv.config();

 const SmeeClient = require('smee-client');

const smee = new SmeeClient({
  source: 'https://smee.io/pIZGABFchezKlej',
  target: 'https://phantomx.dev/v1/api/auth/github/webhooks/github',
  logger: console
});
 const events = smee.start();

export interface InstallationRecord {
  account: {
    login: string;
    id: number;
    type: string;
    [key: string]: any;
  };
  token: string;
  expiresAt: Date;
}

export interface GitHubWebhookRequest extends Request {
  body: any;
}

// In-memory stores
export const installations: Record<number, InstallationRecord> = {};

// GitHub App Configuration
export const APP_ID: any = process.env.GITHUB_APP_ID;
export const PRIVATE_KEY_PATH: any = process.env.GITHUB_PRIVATE_KEY_PATH;
export const WEBHOOK_SECRET: any = process.env.WEHOOK_SECRET;

// Validations
if (!APP_ID) {
  throw new Error("GITHUB_APP_ID not set");
}
if (!PRIVATE_KEY_PATH) {
  throw new Error("GITHUB_PRIVATE_KEY_PATH not set");
}
if (!WEBHOOK_SECRET) {
  console.warn("Warning: WEBHOOK_SECRET not set; you should set it to verify webhooks");
}

// Function to read private key from file
export function readPrivateKeyFromFile(filePath: string): string {
  try {
    console.log(`Attempting to read private key from: ${filePath}`);

    let normalizedPath = filePath;
    if (filePath.includes(':\\')) {
      const isWsl = process.env.WSL_DISTRO_NAME || process.env.IS_WSL;
      if (isWsl) {
        const driveLetter = filePath.charAt(0).toLowerCase();
        const pathWithoutDrive = filePath.substring(2).replace(/\\/g, '/');
        normalizedPath = `/mnt/${driveLetter}${pathWithoutDrive}`;
        console.log(`Converted Windows path to WSL path: ${normalizedPath}`);
      }
    }

    return fs.readFileSync(normalizedPath, 'utf8');
  } catch (error) {
    console.error(`Error reading private key: ${error}`);
    throw new Error(`Failed to read private key from file ${filePath}: ${error}`);
  }
}

const app = express();
app.use(
  bodyParser.json({
    verify: (req: any, res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);

export function verifyWebhookSignature(req: Request, secret: string): boolean {
  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  if (!signature) {
    return false;
  }
  const raw = (req as any).rawBody as Buffer;
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(raw);
  const expected = `sha256=${hmac.digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function generateAppInstallationUrl(state1:string):string {
  
    const params = new URLSearchParams({
      state: state1
    });
    return `https://github.com/apps/${process.env.GITHUB_APP_NAME}/installations/new?state=${state1}`


}

// GitHub App Functions
export function generateAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 540,
    iss: parseInt(APP_ID, 10),
  };
  const privateKey = readPrivateKeyFromFile(PRIVATE_KEY_PATH);
  const token = jwt.sign(payload, privateKey, { algorithm: "RS256" });
  return token;
}

export async function fetchInstallationToken(installationId: number): Promise<{ token: string; expires_at: string }> {
  const jwtToken = generateAppJwt();
  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwtToken}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Error fetching installation token: ${resp.status} : ${body}`);
  }
  const body = (await resp.json()) as any;
  return {
    token: body.token,
    expires_at: body.expires_at,
  };
}

export async function getGithubOrganizationName(installationId:number):Promise<string>
{
    const jwtToken = generateAppJwt();
    const url = `https://api.github.com/app/installations/${installationId}`;
    const resp = await fetch(url,{
      method: "GET",
      headers:{
        Authorization: `Bearer ${jwtToken}`,
        Accept: "application/vnd.github+json",
      },

    });

    if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Error fetching installation token: ${resp.status} : ${body}`);
  }
  const body = (await resp.json()) as any;
  return body.account.login;

}

export async function getRepoList(installationId:number):Promise<any>{

  const installationToken = (await fetchInstallationToken(installationId)).token; //getting the installation Token
  // data.repositories is an array of repo objects
  const octokit = new Octokit({auth: process.env.GITHUB_PAT});
  try{

    const data = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser,{
      per_page: 200,
      visibility:'all'
    });

     return data.map((repo: any) => repo.name);
  }
  catch(err:any)
  {
    console.log("Error listing repositories:", err);
    throw err;
  }
 

}

export async function getRepoBranch(installationId:number, owner:string, repo:string):Promise<any[]>
{
  const installationToken = (await fetchInstallationToken(installationId)).token; //getting the installation Token
  const octokit = new Octokit({ auth: process.env.GITHUB_PAT});
  try {
    const branches = await octokit.paginate(octokit.rest.repos.listBranches, {
      owner,
      repo,
      per_page: 1000
    });

    return branches as any;
  }
  catch (err: any) {
    console.log("Error listing branches:", err);
    throw err;
  }
}