import {
    default as objectPath
} from 'object-path';

import {
    default as clone
} from 'clone';

import * as util from './util';

class RxSchema {
    constructor(jsonID) {
        this.jsonID = clone(jsonID);

        this.compoundIndexes = this.jsonID.compoundIndexes || [];
        delete this.jsonID.compoundIndexes;

        // make indexes required
        this.indexes = getIndexes(this.jsonID);
        this.jsonID.required = this.jsonID.required || [];

        this.indexes.map(indexAr => {
            indexAr
                .filter(index => !this.jsonID.required.includes(index))
                .forEach(index => this.jsonID.required.push(index));
        });

        // primary
        this.primaryPath = getPrimary(this.jsonID);
        if (this.primaryPath)
            this.jsonID.required.push(this.primaryPath);

        // add _id
        this.jsonID.properties._id = {
            type: 'string',
            minLength: 1
        };

        // add _rev
        this.jsonID.properties._rev = {
            type: 'string',
            minLength: 1
        };

        // true if schema contains a crypt-field
        this.crypt = hasCrypt(this.jsonID);
        this.encryptedPaths;

        this.jsonID.additionalProperties = false;
    }

    getSchemaByObjectPath(path) {
        path = path.replace(/\./g, '.properties.');
        path = 'properties.' + path;
        return objectPath.get(this.jsonID, path);
    }

    /**
     * get all encrypted paths
     */
    getEncryptedPaths() {
        if (!this.encryptedPaths) this.encryptedPaths = getEncryptedPaths(this.jsonID);
        return this.encryptedPaths;
    }

    /**
     * validate if the obj matches the schema
     * @param {Object} obj
     * @param {Object} schemaObj json-schema
     */
    validate(obj, schemaObj) {
        schemaObj = schemaObj || this.jsonID;
        util.jsonSchemaValidate(schemaObj, obj);
        return true;
    }

    hash = () => util.hash(this.jsonID)

    swapIdToPrimary(obj) {
        if (!this.primaryPath) return obj;
        obj[this.primaryPath] = obj._id;
        delete obj._id;
        return obj;
    }
    swapPrimaryToId(obj) {
        if (!this.primaryPath) return obj;
        obj._id = obj[this.primaryPath];
        delete obj[this.primaryPath];
        return obj;
    }

}

/**
 * returns all encrypted paths of the schema
 * @param  {Object} jsonSchema [description]
 * @return {Object} with paths as attr and schema as value
 */
export function getEncryptedPaths(jsonSchema) {
    const ret = {};

    function traverse(currentObj, currentPath) {
        if (typeof currentObj !== 'object') return;
        if (currentObj.encrypted) {
            ret[currentPath.substring(1)] = currentObj;
            return;
        }
        for (let attributeName in currentObj) {
            let nextPath = currentPath;
            if (attributeName != 'properties') nextPath = nextPath + '.' + attributeName;
            traverse(currentObj[attributeName], nextPath);
        }
    }
    traverse(jsonSchema, '');
    return ret;
}

/**
 * returns true if schema contains an encrypted field
 * @param  {object} jsonSchema with schema
 * @return {boolean} isEncrypted
 */
export function hasCrypt(jsonSchema) {
    const paths = getEncryptedPaths(jsonSchema);
    if (Object.keys(paths).length > 0) return true;
    else return false;
}


export function getIndexes(jsonID) {
    return Object.keys(jsonID.properties)
        .filter(key => jsonID.properties[key].index)
        .map(key => [key])
        .concat(jsonID.compoundIndexes || [])
        .filter((elem, pos, arr) => arr.indexOf(elem) == pos); // unique
}


export function getPrimary(jsonID) {
    return Object.keys(jsonID.properties)
        .filter(key => jsonID.properties[key].primary)
        .shift();
}


/**
 * validate that all schema-related things are ok
 * @param  {object} jsonSchema
 * @return {boolean} true always
 */
export function validateFieldsDeep(jsonSchema) {

    function checkField(fieldName, schemaObj, path) {
        // all
        if (['properties', 'language'].includes(fieldName))
            throw new Error(`fieldname is not allowed: ${fieldName}`);
        if (fieldName.includes('.'))
            throw new Error(`field-names cannot contain dots: ${fieldName}`);

        const isNested = path.split('.').length >= 2;
        // nested only
        if (isNested) {
            if (schemaObj.primary)
                throw new Error('primary can only be defined at top-level');
            if (schemaObj.index)
                throw new Error('index can only be defined at top-level');
        }
        // first level
        if (!isNested) {
            // check underscore fields
            if (fieldName.charAt(0) == '_')
                throw new Error(`first level-fields cannot start with underscore _ ${fieldName}`);
        }
    }

    function traverse(currentObj, currentPath) {
        if (typeof currentObj !== 'object') return;
        for (let attributeName in currentObj) {
            if (!currentObj.properties) {
                checkField(
                    attributeName,
                    currentObj[attributeName],
                    currentPath
                );
            }
            let nextPath = currentPath;
            if (attributeName != 'properties') nextPath = nextPath + '.' + attributeName;
            traverse(currentObj[attributeName], nextPath);
        }
    }
    traverse(jsonSchema, '');
    return true;
}

/**
 * check if the given schemaJSON is useable for the database
 */
export function checkSchema(jsonID) {

    // check _id
    if (jsonID.properties._id)
        throw new Error('schema defines ._id, this will be done automatically');

    // check _rev
    if (jsonID.properties._rev)
        throw new Error('schema defines ._rev, this will be done automatically');

    validateFieldsDeep(jsonID);

    let primaryPath;
    Object.keys(jsonID.properties).forEach(key => {
        const value = jsonID.properties[key];
        // check primary
        if (value.primary) {
            if (primaryPath)
                throw new Error('primary can only be defined once');

            primaryPath = key;

            if (value.index)
                throw new Error('primary is always index, do not declare it as index');
            if (value.unique)
                throw new Error('primary is always unique, do not declare it as unique');
            if (value.encrypted)
                throw new Error('primary cannot be encrypted');
            if (value.type !== 'string')
                throw new Error('primary must have type: string');
        }
    });

    if (primaryPath && jsonID && jsonID.required && jsonID.required.includes(primaryPath))
        throw new Error('primary is always required, do not declare it as required');


    // check format of jsonID.compoundIndexes
    if (jsonID.compoundIndexes) {
        try {
            /**
             * TODO do not validate via jsonschema here so that the validation
             * can be a seperate, optional module to decrease build-size
             */
            util.jsonSchemaValidate({
                type: 'array',
                items: {
                    type: 'array',
                    items: {
                        type: 'string'
                    }
                }
            }, jsonID.compoundIndexes);
        } catch (e) {
            throw new Error('schema.compoundIndexes must be array<array><string>');
        }
    }

    // check that indexes are string
    getIndexes(jsonID)
        .reduce((a, b) => a.concat(b), [])
        .filter((elem, pos, arr) => arr.indexOf(elem) == pos) // unique
        .filter(indexKey =>
            jsonID.properties[indexKey].type != 'string' &&
            jsonID.properties[indexKey].type != 'integer'
        )
        .forEach(indexKey => {
            throw new Error(
                `given indexKey (${indexKey}) is not type:string but
                ${jsonID.properties[indexKey].type}`
            );
        });
}

export function create(jsonID) {
    checkSchema(jsonID);
    return new RxSchema(jsonID);
}
