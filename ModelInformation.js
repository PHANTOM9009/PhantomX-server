// this isthe sample data for the collection ModelInformation, this collection should be created under the database "General"
[
    {
  _id: ObjectId('69b077eac8881e26e01df896'),
  modelKey: 'gpt_55',
  modelId: 'gpt-5.5',
  price_per_input_token: Double('0.0000025'),
  price_per_output_token: Double('0.000015'),
  price_per_input_batch: NumberInt('0'),
  price_per_output_batch: NumberInt('0'),
  price_cache_write: NumberInt('0'),
  price_cache_read: Double('1.4e-7'),
  max_input_tokens: NumberLong('1050000'),
  azure_api_endpoint: 'https://oppie-molq7ywa-eastus2.cognitiveservices.azure.com/openai/responses?api-version=2025-04-01-preview'
},
{
  _id: ObjectId('694593ebe270cdebb95190bf'),
  modelKey: 'Claude_Sonnet_45',
  modelId: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  price_per_input_token: Double('0.003'),
  price_per_output_token: Double('0.015'),
  price_per_input_batch: Double('0.0015'),
  price_per_output_batch: Double('0.0075'),
  price_cache_write: Double('0.00375'),
  price_cache_read: Double('0.0003'),
  max_input_tokens: NumberLong('2000000')
}
]