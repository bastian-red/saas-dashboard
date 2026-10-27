/**
 * Refuse to boot if any workspace route has no declared permission.
 *
 * TenantGuard already answers 403 at request time for such a route, but a route
 * that is refused for everyone is a bug nobody notices until a user reports it.
 * Failing at boot names the handler instead. Runs once, on bootstrap.
 */
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';

import { REQUIRES } from './tenant.guard';

export interface AuditedRoute {
  controller: string;
  handler: string;
  method: string;
  path: string;
  action: string | undefined;
}

@Injectable()
export class RouteAudit implements OnApplicationBootstrap {
  readonly routes: AuditedRoute[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (instance === undefined || wrapper.metatype === null) continue;
      const base = String(
        this.reflector.get<string>(
          PATH_METADATA,
          wrapper.metatype as unknown as new () => unknown,
        ) ?? '',
      );
      for (const name of this.scanner.getAllMethodNames(
        Object.getPrototypeOf(instance) as object,
      )) {
        const handler = instance[name] as (...args: unknown[]) => unknown;
        const sub = this.reflector.get<string | undefined>(PATH_METADATA, handler);
        if (sub === undefined) continue;
        const path = `/${[base, sub].filter((p) => p !== '' && p !== '/').join('/')}`;
        const action = this.reflector.get<string | undefined>(REQUIRES, handler);
        const method = RequestMethod[this.reflector.get<RequestMethod>(METHOD_METADATA, handler)];
        this.routes.push({ controller: wrapper.name, handler: name, method, path, action });
      }
    }
    const missing = this.routes.filter(
      (r) => r.path.includes(':workspace') && r.action === undefined,
    );
    if (missing.length > 0) {
      throw new Error(
        `Workspace routes without @Requires: ${missing.map((r) => `${r.controller}.${r.handler} ${r.path}`).join(', ')}`,
      );
    }
  }
}
