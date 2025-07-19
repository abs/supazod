import fs from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import prettier from 'prettier';
import { generate } from 'ts-to-zod';
import ts from 'typescript';
import { z } from 'zod';

import {
  transformTypes,
  getImportPath,
  transformTypesOptionsSchema,
  getAllSchemas,
  namingConfigSchema,
  defaultNamingConfig,
} from './lib';
import { replaceGeneratedComment } from './lib/comment-utils';
import { logger } from './lib/logger';
import { defaultTypeNameTransformer } from './lib/transform-name-utils';
import { transformTypeNames } from './lib/transform-type-names';

const simplifiedJSDocTagSchema = z.object({
  name: z.string(),
  value: z.string().optional(),
});

const getSchemaNameSchema = z.function().args(z.string()).returns(z.string());
const nameFilterSchema = z.function().args(z.string()).returns(z.boolean());
const jSDocTagFilterSchema = z
  .function()
  .args(z.array(simplifiedJSDocTagSchema))
  .returns(z.boolean());

export const supabaseToZodOptionsSchema = transformTypesOptionsSchema
  .omit({ sourceText: true })
  .extend({
    input: z.string(),
    output: z.string(),
    typesOutput: z.string().optional(),
    schema: z
      .union([z.string(), z.array(z.string())])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    skipValidation: z.boolean().optional(),
    maxRun: z.number().optional(),
    nameFilter: nameFilterSchema.optional(),
    jsDocTagFilter: jSDocTagFilterSchema.optional(),
    getSchemaName: getSchemaNameSchema.optional(),
    keepComments: z.boolean().optional().default(false),
    skipParseJSDoc: z.boolean().optional().default(false),
    verbose: z.boolean().optional().default(false),
    typeNameTransformer: z
      .function()
      .args(z.string())
      .returns(z.string())
      .optional()
      .default(() => defaultTypeNameTransformer),
    namingConfig: namingConfigSchema.optional().default(defaultNamingConfig),
  });

export type SupabaseToZodOptions = z.infer<typeof supabaseToZodOptionsSchema>;

async function collectTypes(
  sourceText: string,
  opts: Omit<SupabaseToZodOptions, 'schema'> & { schema: string },
) {
  const sourceFile = ts.createSourceFile(
    'temp.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );

  function transform(context: ts.TransformationContext) {
    return (node: ts.Node): ts.Node => {
      if (
        ts.isPropertySignature(node) &&
        node.type &&
        ((ts.isArrayTypeNode(node.type) &&
          (!node.type.elementType ||
            node.type.elementType.kind === ts.SyntaxKind.LastTypeNode)) ||
          (node.type.kind === ts.SyntaxKind.TupleType &&
            (node.type as ts.TupleTypeNode).elements.length === 0))
      ) {
        return ts.factory.updatePropertySignature(
          node,
          node.modifiers,
          node.name,
          node.questionToken,
          ts.factory.createArrayTypeNode(
            ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ),
        );
      }
      return ts.visitEachChild(node, transform(context), context);
    };
  }

  const result = ts.transform(sourceFile, [transform]);
  const transformedSourceFile = result.transformed[0];
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const processedSourceText = printer.printNode(
    ts.EmitHint.Unspecified,
    transformedSourceFile,
    sourceFile,
  );

  result.dispose();

  return transformTypes({ sourceText: processedSourceText, ...opts });
}

export default async function supabaseToZod(opts: SupabaseToZodOptions) {
  const result = await generateContent(opts);
  if (!result) {
    logger.error('Failed to generate schemas', '❌');
    return;
  }

  logger.info('Writing schema file...', '💾');
  await fs.writeFile(opts.output, result.formatterSchemasFileContent);

  if (opts.typesOutput && result.formatterTypesFileContent) {
    logger.info('Writing types file...', '📝');
    await fs.writeFile(opts.typesOutput, result.formatterTypesFileContent);
  }

  logger.info('Successfully generated Zod schemas!', '✅');
}

export async function generateContent(opts: SupabaseToZodOptions) {
  logger.setVerbose(opts.verbose || false);

  const inputPath = isAbsolute(opts.input)
    ? opts.input
    : join(process.cwd(), opts.input);
  const outputPath = isAbsolute(opts.output)
    ? opts.output
    : join(process.cwd(), opts.output);

  logger.info('Reading input file...', '📦');
  const sourceText = await fs.readFile(inputPath, 'utf-8');

  if (!opts.schema.length) {
    logger.warn(`No schema specified, using all available schemas`, '🤖');
    opts.schema = getAllSchemas(sourceText);
  }
  if (!opts.schema.length) throw new Error('No schemas specified');

  logger.info(`Detected schemas: ${opts.schema.join(', ')}`, '📋');

  let parsedTypes = '';
  logger.info('Transforming types...', '🔄');
  for (const schema of opts.schema) {
    parsedTypes += await collectTypes(sourceText, { ...opts, schema });
  }

  logger.info('Generating Zod schemas...', '📠');
  const { getZodSchemasFile, getInferredTypes, errors } = generate({
    sourceText: parsedTypes,
    ...opts,
  });
  if (errors.length > 0) throw new Error('Schema generation failed.');

  // 1) switch generated import to Astro's Zod
  let zodSchemasFile = getZodSchemasFile(getImportPath(outputPath, inputPath));
  zodSchemasFile = zodSchemasFile.replace(
    /import \{ z \} from ['"]zod['"];/,
    `import { z } from 'astro:content';`,
  );

  // 2) inject a valid, typed jsonSchema definition
  zodSchemasFile = zodSchemasFile.replace(
    /export const jsonSchema[\s\S]*?;\n/m,
    `export const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.record(z.string(), jsonSchema),
    z.array(jsonSchema),
  ])
);
`,
  );

  // 3) alias publicAccountRowSchema as accountRowSchema
  zodSchemasFile +=
    '\nexport { publicAccountRowSchema as accountRowSchema };\n';

  const contentWithNewComment = replaceGeneratedComment(zodSchemasFile);
  const formatterSchemasFileContent = await prettier.format(
    contentWithNewComment,
    { parser: 'babel-ts' },
  );

  if (opts.typesOutput) {
    const typesOutputPath = join(process.cwd(), opts.typesOutput);
    let typesContent = getInferredTypes(
      getImportPath(typesOutputPath, outputPath),
    );
    typesContent = transformTypeNames(typesContent, opts.typeNameTransformer);
    const typesWithNewComment = replaceGeneratedComment(typesContent);
    const formatterTypesFileContent = await prettier.format(
      typesWithNewComment,
      { parser: 'babel-ts' },
    );
    return {
      rawSchemasFileContent: contentWithNewComment,
      rawTypesFileContent: typesWithNewComment,
      formatterSchemasFileContent,
      formatterTypesFileContent,
    };
  }

  return {
    rawSchemasFileContent: contentWithNewComment,
    formatterSchemasFileContent,
  };
}
