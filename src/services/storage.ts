const ROOT = '__ROOT__';
import { service, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { LoggingService } from './logging';
import * as fse from 'fs-extra';
import { resolve as pathResolve } from 'path';
import * as _get from 'lodash.get';
import * as _set from 'lodash.set';

@service('storage')
export class StorageService {
    @inject('$server')
    private server: Server;

    @inject('logger')
    private logger: LoggingService;

    private setupDone = false;
    private storageDirectory;

    public async init() {
        this.logger.log(['StorageService', 'info'], 'initialize');

        this.storageDirectory = _get(this.server, 'settings.app.storageRootDirectory');

        this.setup();
    }

    public async get(scope: string, property?: string): Promise<any> {
        if (!property) {
            property = ROOT;
        }

        const obj = await this.readScope(scope);

        if (!obj) {
            return {};
        }

        if (property === ROOT) {
            return obj;
        }

        return _get(obj, property);
    }

    public async set(scope: string, property: any, value?: any) {
        if (!value) {
            value = property;
            property = ROOT;
        }

        const obj = await this.readScope(scope);

        const finalObject = (property === ROOT)
            ? value
            : _set(obj || {}, property, value);

        this.writeScope(scope, finalObject);
    }

    public async flush(scope: string, property: string, value?: any) {
        if (!value) {
            value = property;
            property = ROOT;
        }

        const finalObject = (property === ROOT)
            ? value
            : _set({}, property, value);

        this.writeScope(scope, finalObject);
    }

    private setup() {
        if (this.setupDone === true) {
            return;
        }

        fse.ensureDirSync(this.storageDirectory);

        this.setupDone = true;
    }

    private async readScope(scope): Promise<any> {
        try {
            this.setup();

            const exists = await fse.pathExists(this.getScopePath(scope));
            if (!exists) {
                return {};
            }

            return fse.readJson(this.getScopePath(scope));
        }
        catch (ex) {
            return {};
        }
    }

    private writeScope(scope, data) {
        this.setup();

        const writeOptions = {
            spaces: 2,
            throws: false
        };

        try {
            fse.writeJsonSync(this.getScopePath(scope), data, writeOptions);
        }
        catch (ex) {
            // eat exception
        }
    }

    private getScopePath(scope) {
        return pathResolve(this.storageDirectory, `${scope}.json`);
    }
}
