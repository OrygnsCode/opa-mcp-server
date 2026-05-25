/**
 * Server identity constants shared between the entry point and the
 * mcp_server_info tool. Defined here to avoid a circular import
 * (server.ts -> tools -> meta -> server.ts).
 */
export const SERVER_NAME = 'orygn-opa-mcp';
export const SERVER_VERSION = '0.1.12';
