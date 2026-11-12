import { test, describe } from 'node:test';
import assert from 'node:assert';
import { TypeScriptAnalyzer } from '../analyzer/analyzers/typeScriptAnalyzer';
import { NodalEngine } from '../analyzer/nodalEngine';
import { GraphStorage } from '../analyzer/graphStorage';
import { RepositoryFile } from '../analyzer/types';

describe('AST Symbol Extraction & Relationship Engine Tests', () => {
  const analyzer = new TypeScriptAnalyzer();

  test('1. Spec Example: UserService & AuthService injection and call resolution', async () => {
    const code = `
class UserService {
    getUser() {
        return "user";
    }
}

class AuthService {
    constructor(
        private userService: UserService
    ) {}

    login() {
        return this.userService.getUser();
    }
}
    `.trim();

    const files: RepositoryFile[] = [
      { filePath: 'src/services/auth.ts', content: code },
    ];

    const result = await analyzer.analyze('repo-test-1', files);

    // Verify Symbols
    const symbolNames = result.symbols.map((s) => s.name);
    assert.ok(symbolNames.includes('UserService'), 'Should extract UserService class');
    assert.ok(symbolNames.includes('AuthService'), 'Should extract AuthService class');
    assert.ok(symbolNames.includes('getUser'), 'Should extract getUser method');
    assert.ok(symbolNames.includes('login'), 'Should extract login method');
    assert.ok(symbolNames.includes('constructor'), 'Should extract constructor');

    // Verify Relationships
    const authServiceSym = result.symbols.find((s) => s.name === 'AuthService' && s.type === 'class');
    const userServiceSym = result.symbols.find((s) => s.name === 'UserService' && s.type === 'class');
    const loginSym = result.symbols.find((s) => s.name === 'login' && s.type === 'method');
    const getUserSym = result.symbols.find((s) => s.name === 'getUser' && s.type === 'method');

    assert.ok(authServiceSym && userServiceSym && loginSym && getUserSym);

    // AuthService --INJECTS--> UserService
    const injectRel = result.relationships.find(
      (r) =>
        r.sourceSymbolId === authServiceSym.id &&
        r.targetSymbolId === userServiceSym.id &&
        r.relationshipType === 'INJECTS'
    );
    assert.ok(injectRel, 'AuthService should INJECT UserService');
    assert.strictEqual(injectRel.confidence, 'high');

    // AuthService.login --CALLS--> UserService.getUser
    const callRel = result.relationships.find(
      (r) =>
        r.sourceSymbolId === loginSym.id &&
        r.targetSymbolId === getUserSym.id &&
        r.relationshipType === 'CALLS'
    );
    assert.ok(callRel, 'AuthService.login should CALL UserService.getUser');
    assert.strictEqual(callRel.confidence, 'high');
  });

  test('2. NestJS Framework Patterns: @Controller, @Injectable, and Decorators', async () => {
    const authServiceCode = `
import { Injectable } from '@nestjs/common';

@Injectable()
export class AuthService {
    login() {
        return { token: 'jwt-123' };
    }
}
    `.trim();

    const authControllerCode = `
import { Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
    constructor(
        private readonly authService: AuthService
    ) {}

    @Post('login')
    login() {
        return this.authService.login();
    }
}
    `.trim();

    const files: RepositoryFile[] = [
      { filePath: 'src/auth/auth.service.ts', content: authServiceCode },
      { filePath: 'src/auth/auth.controller.ts', content: authControllerCode },
    ];

    const result = await analyzer.analyze('repo-nestjs-test', files);

    const controllerSym = result.symbols.find((s) => s.name === 'AuthController' && s.type === 'class');
    const serviceSym = result.symbols.find((s) => s.name === 'AuthService' && s.type === 'class');
    const controllerLoginSym = result.symbols.find(
      (s) => s.id.includes('AuthController.login') && s.type === 'method'
    );
    const serviceLoginSym = result.symbols.find(
      (s) => s.id.includes('AuthService.login') && s.type === 'method'
    );

    assert.ok(controllerSym, 'AuthController symbol must exist');
    assert.ok(serviceSym, 'AuthService symbol must exist');
    assert.ok(controllerLoginSym, 'AuthController.login symbol must exist');
    assert.ok(serviceLoginSym, 'AuthService.login symbol must exist');

    // Controller INJECTS Service
    const injectRel = result.relationships.find(
      (r) =>
        r.sourceSymbolId === controllerSym.id &&
        r.targetSymbolId === serviceSym.id &&
        r.relationshipType === 'INJECTS'
    );
    assert.ok(injectRel, 'AuthController should INJECT AuthService');

    // Controller.login CALLS Service.login
    const callRel = result.relationships.find(
      (r) =>
        r.sourceSymbolId === controllerLoginSym.id &&
        r.targetSymbolId === serviceLoginSym.id &&
        r.relationshipType === 'CALLS'
    );
    assert.ok(callRel, 'AuthController.login should CALL AuthService.login');
  });

  test('3. EXTENDS and IMPLEMENTS static inheritance relationships', async () => {
    const code = `
export interface UserOperations {
    findUser(id: string): any;
}

export class BaseService {
    log(msg: string) {
        console.log(msg);
    }
}

export class UserService extends BaseService implements UserOperations {
    findUser(id: string) {
        this.log('Finding user ' + id);
        return { id };
    }
}
    `.trim();

    const files: RepositoryFile[] = [
      { filePath: 'src/users/user.service.ts', content: code },
    ];

    const result = await analyzer.analyze('repo-oop-test', files);

    const userOpIface = result.symbols.find((s) => s.name === 'UserOperations' && s.type === 'interface');
    const baseServiceClass = result.symbols.find((s) => s.name === 'BaseService' && s.type === 'class');
    const userServiceClass = result.symbols.find((s) => s.name === 'UserService' && s.type === 'class');
    const findUserMethod = result.symbols.find((s) => s.name === 'findUser' && s.type === 'method');
    const logMethod = result.symbols.find((s) => s.name === 'log' && s.type === 'method');

    assert.ok(userOpIface && baseServiceClass && userServiceClass && findUserMethod && logMethod);

    // UserService EXTENDS BaseService
    const extendsRel = result.relationships.find(
      (r) =>
        r.sourceSymbolId === userServiceClass.id &&
        r.targetSymbolId === baseServiceClass.id &&
        r.relationshipType === 'EXTENDS'
    );
    assert.ok(extendsRel, 'UserService should EXTEND BaseService');

    // UserService IMPLEMENTS UserOperations
    const implementsRel = result.relationships.find(
      (r) =>
        r.sourceSymbolId === userServiceClass.id &&
        r.targetSymbolId === userOpIface.id &&
        r.relationshipType === 'IMPLEMENTS'
    );
    assert.ok(implementsRel, 'UserService should IMPLEMENT UserOperations');

    // Local method call on inherited/this: this.log(...)
    const logCallRel = result.relationships.find(
      (r) =>
        r.sourceSymbolId === findUserMethod.id &&
        r.relationshipType === 'CALLS'
    );
    assert.ok(logCallRel, 'findUser should call method');
  });

  test('4. Standalone functions, Enums, Exported variables & Local Calls', async () => {
    const code = `
export enum UserRole {
    ADMIN = 'ADMIN',
    USER = 'USER'
}

export const APP_CONFIG = {
    port: 3000
};

export function helperFunction(val: string) {
    return val.toUpperCase();
}

export function mainProcessor(input: string) {
    return helperFunction(input);
}
    `.trim();

    const files: RepositoryFile[] = [
      { filePath: 'src/utils/helpers.ts', content: code },
    ];

    const result = await analyzer.analyze('repo-utils-test', files);

    const enumSym = result.symbols.find((s) => s.name === 'UserRole' && s.type === 'enum');
    const varSym = result.symbols.find((s) => s.name === 'APP_CONFIG' && s.type === 'variable');
    const helperSym = result.symbols.find((s) => s.name === 'helperFunction' && s.type === 'function');
    const mainSym = result.symbols.find((s) => s.name === 'mainProcessor' && s.type === 'function');

    assert.ok(enumSym, 'Enum UserRole should be extracted');
    assert.ok(varSym, 'Exported variable APP_CONFIG should be extracted');
    assert.ok(helperSym, 'Function helperFunction should be extracted');
    assert.ok(mainSym, 'Function mainProcessor should be extracted');

    // Function call relationship
    const callRel = result.relationships.find(
      (r) =>
        r.sourceSymbolId === mainSym.id &&
        r.targetSymbolId === helperSym.id &&
        r.relationshipType === 'CALLS'
    );
    assert.ok(callRel, 'mainProcessor should CALL helperFunction');
  });

  test('5. Multi-tier NestJS Architecture: Controller -> Service -> Repository flow', async () => {
    const repoCode = `
export class UserRepository {
    findById(id: string) {
        return { id, name: 'John Doe' };
    }
}
    `.trim();

    const serviceCode = `
import { UserRepository } from './user.repository';

export class UserService {
    constructor(private userRepo: UserRepository) {}

    getUser(id: string) {
        return this.userRepo.findById(id);
    }
}
    `.trim();

    const controllerCode = `
import { UserService } from './user.service';

export class UserController {
    constructor(private userService: UserService) {}

    handleGet(id: string) {
        return this.userService.getUser(id);
    }
}
    `.trim();

    const files: RepositoryFile[] = [
      { filePath: 'src/users/user.repository.ts', content: repoCode },
      { filePath: 'src/users/user.service.ts', content: serviceCode },
      { filePath: 'src/users/user.controller.ts', content: controllerCode },
    ];

    const result = await NodalEngine.analyze('repo-3tier-test', files);

    assert.strictEqual(result.errors.length, 0, 'Should parse without errors');

    // Verify 3-tier injection chain:
    // UserController --INJECTS--> UserService
    // UserService --INJECTS--> UserRepository
    const controllerSym = result.symbols.find((s) => s.name === 'UserController' && s.type === 'class');
    const serviceSym = result.symbols.find((s) => s.name === 'UserService' && s.type === 'class');
    const repoSym = result.symbols.find((s) => s.name === 'UserRepository' && s.type === 'class');

    assert.ok(controllerSym && serviceSym && repoSym);

    const cToS = result.relationships.find(
      (r) => r.sourceSymbolId === controllerSym.id && r.targetSymbolId === serviceSym.id && r.relationshipType === 'INJECTS'
    );
    const sToR = result.relationships.find(
      (r) => r.sourceSymbolId === serviceSym.id && r.targetSymbolId === repoSym.id && r.relationshipType === 'INJECTS'
    );

    assert.ok(cToS, 'UserController -> INJECTS -> UserService');
    assert.ok(sToR, 'UserService -> INJECTS -> UserRepository');

    // Verify 3-tier method call chain:
    // UserController.handleGet -> UserService.getUser -> UserRepository.findById
    const handleGetSym = result.symbols.find((s) => s.id.includes('UserController.handleGet'));
    const getUserSym = result.symbols.find((s) => s.id.includes('UserService.getUser'));
    const findByIdSym = result.symbols.find((s) => s.id.includes('UserRepository.findById'));

    assert.ok(handleGetSym && getUserSym && findByIdSym);

    const call1 = result.relationships.find(
      (r) => r.sourceSymbolId === handleGetSym.id && r.targetSymbolId === getUserSym.id && r.relationshipType === 'CALLS'
    );
    const call2 = result.relationships.find(
      (r) => r.sourceSymbolId === getUserSym.id && r.targetSymbolId === findByIdSym.id && r.relationshipType === 'CALLS'
    );

    assert.ok(call1, 'UserController.handleGet -> CALLS -> UserService.getUser');
    assert.ok(call2, 'UserService.getUser -> CALLS -> UserRepository.findById');
  });

  test('6. Error Resilience: Broken/Malformed file does not halt entire repository analysis', async () => {
    const validFile1: RepositoryFile = {
      filePath: 'src/good1.ts',
      content: `export class GoodOne { test() { return 1; } }`,
    };
    const brokenFile: RepositoryFile = {
      filePath: 'src/broken.ts',
      content: `export class Broken { unclosed constructor( `,
    };
    const validFile2: RepositoryFile = {
      filePath: 'src/good2.ts',
      content: `export class GoodTwo { run() { return 2; } }`,
    };

    const result = await NodalEngine.analyze('repo-resilience-test', [validFile1, brokenFile, validFile2]);

    // Symbols from good files must be present
    const names = result.symbols.map((s) => s.name);
    assert.ok(names.includes('GoodOne'), 'GoodOne must be analyzed');
    assert.ok(names.includes('GoodTwo'), 'GoodTwo must be analyzed');
    assert.ok(result.symbols.length >= 2, 'Valid symbols extracted');
  });

  test('7. Strict Repository Isolation: Symbols and relationships never cross repositories', async () => {
    const filesRepoA: RepositoryFile[] = [
      { filePath: 'src/service.ts', content: 'export class RepoAService { doWork() {} }' },
    ];
    const filesRepoB: RepositoryFile[] = [
      { filePath: 'src/service.ts', content: 'export class RepoBService { doWork() {} }' },
    ];

    const resultA = await NodalEngine.analyze('repo-A', filesRepoA);
    const resultB = await NodalEngine.analyze('repo-B', filesRepoB);

    // Repo A symbols must all start with repo-A
    for (const sym of resultA.symbols) {
      assert.strictEqual(sym.repositoryId, 'repo-A');
      assert.ok(sym.id.startsWith('repo-A:'));
    }

    // Repo B symbols must all start with repo-B
    for (const sym of resultB.symbols) {
      assert.strictEqual(sym.repositoryId, 'repo-B');
      assert.ok(sym.id.startsWith('repo-B:'));
    }

    // Attempting to store cross-repository relationship must be rejected by GraphStorage validation
    const invalidCrossRepoRel = {
      id: 'repo-A:repo-A:src/service.ts:RepoAService:INJECTS:repo-B:src/service.ts:RepoBService',
      repositoryId: 'repo-A',
      sourceSymbolId: 'repo-A:src/service.ts:RepoAService',
      targetSymbolId: 'repo-B:src/service.ts:RepoBService', // Target is Repo B!
      relationshipType: 'INJECTS' as const,
      confidence: 'high' as const,
    };

    // Verification in GraphStorage validator
    const isolationTestSymbols = [...resultA.symbols];
    const { validRelationships } = GraphStorage.validateGraphData('repo-A', isolationTestSymbols, [invalidCrossRepoRel as any]);

    assert.strictEqual(
      validRelationships.length,
      0,
      'Cross-repository relationship targeting repo-B must be rejected when persisting for repo-A'
    );
  });
});
