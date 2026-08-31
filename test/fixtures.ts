/**
 * A trimmed copy of a real `DescribeInstanceBill` response, keeping every
 * `InstanceID` shape the account actually produces - including the six-segment
 * `qwen3.8-flash` variant with its empty penultimate field.
 */
export const describeInstanceBill = {
  Code: 'Success',
  Message: 'Successful!',
  Success: true,
  Data: {
    BillingCycle: '2026-08',
    TotalCount: 13,
    Items: [
      item('1110389;ws-9h4296dos6ll46s2;glm-5.1;input_token;0', '0', '0', 0),
      item('1110389;ws-9h4296dos6ll46s2;glm-5.1;output_token;0', '0', '0', 0),
      item('1110389;ws-9h4296dos6ll46s2;glm-5.2;input_token;0', '0', '0', 0),
      item('1110389;ws-9h4296dos6ll46s2;glm-5.2;output_token;0', '0', '0', 0),
      item(
        '1110389;ws-9h4296dos6ll46s2;glm-5.2-fast-preview;input_token;0',
        '0.014',
        '0.0028',
        3.92e-5,
      ),
      item(
        '1110389;ws-9h4296dos6ll46s2;glm-5.2-fast-preview;output_token;0',
        '0.105',
        '0.0088',
        9.24e-4,
      ),
      item('1110389;ws-9h4296dos6ll46s2;kimi-k3;input_token;0', '0', '0', 0),
      item('1110389;ws-9h4296dos6ll46s2;kimi-k3;output_token;0', '0', '0', 0),
      item(
        '1110389;ws-9h4296dos6ll46s2;deepseek-v4-flash;input_token;0',
        '0',
        '0',
        0,
      ),
      item(
        '1110389;ws-9h4296dos6ll46s2;deepseek-v4-flash;output_token;0',
        '0',
        '0',
        0,
      ),
      // Note the extra empty segment before the trailing field.
      item(
        '1110389;ws-9h4296dos6ll46s2;qwen3.8-flash;input_token;;0',
        '0',
        '0',
        0,
      ),
      item(
        '1110389;ws-9h4296dos6ll46s2;qwen3.8-flash;output_token;;0',
        '0',
        '0',
        0,
      ),
      item(
        '1110389;ws-9h4296dos6ll46s2;qwen3.8-flash;input_token_cache;;0',
        '0',
        '0',
        0,
      ),
    ],
  },
}

/** A marketplace line, whose InstanceID follows no known convention. */
export const marketplaceItem = {
  ...item('mp-instance-8842', '0.4', '0.0046', 1.8388e-3),
  ProductCode: 'mpintl-mt9-dt26',
  ProductName: 'Third-Party Services in Marketplace',
}

function item(
  instanceId: string,
  usage: string,
  listPrice: string,
  gross: number,
) {
  return {
    InstanceID: instanceId,
    BillingItem: 'TextModelTokens',
    ProductCode: 'sfm',
    ProductName: 'Alibaba Cloud Model Studio',
    Currency: 'USD',
    Usage: usage,
    UsageUnit: '1K tokens',
    ListPrice: listPrice,
    PretaxGrossAmount: gross,
    // Sub-cent amounts survive at the line level; the round-down to zero
    // happens when the product total is assembled.
    PretaxAmount: gross,
  }
}
