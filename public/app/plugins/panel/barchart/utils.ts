import { orderBy } from 'lodash';
import uPlot, { Padding } from 'uplot';

import {
  ArrayVector,
  DataFrame,
  Field,
  FieldType,
  formattedValueToString,
  getDisplayProcessor,
  getFieldColorModeForField,
  getFieldSeriesColor,
  GrafanaTheme2,
  outerJoinDataFrames,
  reduceField,
  TimeZone,
  VizOrientation,
  DataFrameType,
  getFieldDisplayName,
  Labels,
  formatLabels,
} from '@grafana/data';
import { maybeSortFrame } from '@grafana/data/src/transformations/transformers/joinDataFrames';
import {
  AxisPlacement,
  GraphTransform,
  GraphTresholdsStyleMode,
  ScaleDirection,
  ScaleDistribution,
  ScaleOrientation,
  StackingMode,
  VizLegendOptions,
} from '@grafana/schema';
import { FIXED_UNIT, measureText, UPlotConfigBuilder, UPlotConfigPrepFn, UPLOT_AXIS_FONT_SIZE } from '@grafana/ui';
import { getStackingGroups } from '@grafana/ui/src/components/uPlot/utils';
import { findField } from 'app/features/dimensions';

import { BarsOptions, getConfig } from './bars';
import { PanelFieldConfig, PanelOptions, defaultPanelFieldConfig } from './panelcfg.gen';
import { BarChartDisplayValues, BarChartDisplayWarning } from './types';

function getBarCharScaleOrientation(orientation: VizOrientation) {
  if (orientation === VizOrientation.Vertical) {
    return {
      xOri: ScaleOrientation.Horizontal,
      xDir: ScaleDirection.Right,
      yOri: ScaleOrientation.Vertical,
      yDir: ScaleDirection.Up,
    };
  }

  return {
    xOri: ScaleOrientation.Vertical,
    xDir: ScaleDirection.Down,
    yOri: ScaleOrientation.Horizontal,
    yDir: ScaleDirection.Right,
  };
}

export interface BarChartOptionsEX extends PanelOptions {
  rawValue: (seriesIdx: number, valueIdx: number) => number | null;
  getColor?: (seriesIdx: number, valueIdx: number, value: unknown) => string | null;
  timeZone?: TimeZone;
  fillOpacity?: number;
}

export const preparePlotConfigBuilder: UPlotConfigPrepFn<BarChartOptionsEX> = ({
  frame,
  theme,
  orientation,
  showValue,
  groupWidth,
  barWidth,
  barRadius = 0,
  stacking,
  text,
  rawValue,
  getColor,
  fillOpacity,
  allFrames,
  xTickLabelRotation,
  xTickLabelMaxLength,
  xTickLabelSpacing = 0,
  legend,
  timeZone,
  fullHighlight,
}) => {
  const builder = new UPlotConfigBuilder();

  const formatValue = (seriesIdx: number, value: unknown) => {
    return formattedValueToString(frame.fields[seriesIdx].display!(value));
  };

  const formatShortValue = (seriesIdx: number, value: unknown) => {
    return shortenValue(formatValue(seriesIdx, value), xTickLabelMaxLength);
  };

  // bar orientation -> x scale orientation & direction
  const vizOrientation = getBarCharScaleOrientation(orientation);

  // Use bar width when only one field
  if (frame.fields.length === 2) {
    groupWidth = barWidth;
    barWidth = 1;
  }

  const opts: BarsOptions = {
    xOri: vizOrientation.xOri,
    xDir: vizOrientation.xDir,
    groupWidth,
    barWidth,
    barRadius,
    stacking,
    rawValue,
    getColor,
    fillOpacity,
    formatValue,
    formatShortValue,
    timeZone,
    text,
    showValue,
    legend,
    xSpacing: xTickLabelSpacing,
    xTimeAuto: frame.fields[0]?.type === FieldType.time && !frame.fields[0].config.unit?.startsWith('time:'),
    negY: frame.fields.map((f) => f.config.custom?.transform === GraphTransform.NegativeY),
    fullHighlight,
  };

  const config = getConfig(opts, theme);

  builder.setCursor(config.cursor);

  builder.addHook('init', config.init);
  builder.addHook('drawClear', config.drawClear);
  builder.addHook('draw', config.draw);

  builder.setTooltipInterpolator(config.interpolateTooltip);

  if (xTickLabelRotation !== 0) {
    // these are the amount of space we already have available between plot edge and first label
    // TODO: removing these hardcoded value requires reading back uplot instance props
    let lftSpace = 50;
    let btmSpace = vizOrientation.xOri === ScaleOrientation.Horizontal ? 14 : 5;

    builder.setPadding(getRotationPadding(frame, xTickLabelRotation, xTickLabelMaxLength, lftSpace, btmSpace));
  }

  builder.setPrepData(config.prepData);

  builder.addScale({
    scaleKey: 'x',
    isTime: false,
    range: config.xRange,
    distribution: ScaleDistribution.Ordinal,
    orientation: vizOrientation.xOri,
    direction: vizOrientation.xDir,
  });

  const xFieldAxisPlacement =
    frame.fields[0].config.custom?.axisPlacement !== AxisPlacement.Hidden
      ? vizOrientation.xOri === ScaleOrientation.Horizontal
        ? AxisPlacement.Bottom
        : AxisPlacement.Left
      : AxisPlacement.Hidden;
  const xFieldAxisShow = frame.fields[0].config.custom?.axisPlacement !== AxisPlacement.Hidden;

  builder.addAxis({
    scaleKey: 'x',
    isTime: false,
    placement: xFieldAxisPlacement,
    label: frame.fields[0].config.custom?.axisLabel,
    splits: config.xSplits,
    filter: vizOrientation.xOri === 0 ? config.hFilter : undefined,
    values: config.xValues,
    timeZone,
    grid: { show: false },
    ticks: { show: false },
    gap: 15,
    tickLabelRotation: vizOrientation.xOri === 0 ? xTickLabelRotation * -1 : 0,
    theme,
    show: xFieldAxisShow,
  });

  let seriesIndex = 0;
  const legendOrdered = isLegendOrdered(legend);

  // iterate the y values
  for (let i = 1; i < frame.fields.length; i++) {
    const field = frame.fields[i];

    seriesIndex++;

    const customConfig: PanelFieldConfig = { ...defaultPanelFieldConfig, ...field.config.custom };

    const scaleKey = field.config.unit || FIXED_UNIT;
    const colorMode = getFieldColorModeForField(field);
    const scaleColor = getFieldSeriesColor(field, theme);
    const seriesColor = scaleColor.color;

    // make barcharts start at 0 unless explicitly overridden
    let softMin = customConfig.axisSoftMin;
    let softMax = customConfig.axisSoftMax;

    if (softMin == null && field.config.min == null) {
      softMin = 0;
    }

    if (softMax == null && field.config.max == null) {
      softMax = 0;
    }

    // Render thresholds in graph
    if (customConfig.thresholdsStyle && field.config.thresholds) {
      const thresholdDisplay = customConfig.thresholdsStyle.mode ?? GraphTresholdsStyleMode.Off;
      if (thresholdDisplay !== GraphTresholdsStyleMode.Off) {
        builder.addThresholds({
          config: customConfig.thresholdsStyle,
          thresholds: field.config.thresholds,
          scaleKey,
          theme,
          hardMin: field.config.min,
          hardMax: field.config.max,
          softMin: customConfig.axisSoftMin,
          softMax: customConfig.axisSoftMax,
        });
      }
    }

    builder.addSeries({
      scaleKey,
      pxAlign: true,
      lineWidth: customConfig.lineWidth,
      lineColor: seriesColor,
      fillOpacity: customConfig.fillOpacity,
      theme,
      colorMode,
      pathBuilder: config.barsBuilder,
      show: !customConfig.hideFrom?.viz,
      gradientMode: customConfig.gradientMode,
      thresholds: field.config.thresholds,
      hardMin: field.config.min,
      hardMax: field.config.max,
      softMin,
      softMax,

      // The following properties are not used in the uPlot config, but are utilized as transport for legend config
      // PlotLegend currently gets unfiltered DataFrame[], so index must be into that field array, not the prepped frame's which we're iterating here
      dataFrameFieldIndex: {
        fieldIndex: legendOrdered
          ? i
          : allFrames[0].fields.findIndex(
              (f) => f.type === FieldType.number && f.state?.seriesIndex === seriesIndex - 1
            ),
        frameIndex: 0,
      },
    });

    // The builder will manage unique scaleKeys and combine where appropriate
    builder.addScale({
      scaleKey,
      min: field.config.min,
      max: field.config.max,
      softMin,
      softMax,
      orientation: vizOrientation.yOri,
      direction: vizOrientation.yDir,
      distribution: customConfig.scaleDistribution?.type,
      log: customConfig.scaleDistribution?.log,
    });

    if (customConfig.axisPlacement !== AxisPlacement.Hidden) {
      let placement = customConfig.axisPlacement;
      if (!placement || placement === AxisPlacement.Auto) {
        placement = AxisPlacement.Left;
      }
      if (vizOrientation.xOri === 1) {
        if (placement === AxisPlacement.Left) {
          placement = AxisPlacement.Bottom;
        }
        if (placement === AxisPlacement.Right) {
          placement = AxisPlacement.Top;
        }
      }

      builder.addAxis({
        scaleKey,
        label: customConfig.axisLabel,
        size: customConfig.axisWidth,
        placement,
        formatValue: (v, decimals) => formattedValueToString(field.display!(v, decimals)),
        filter: vizOrientation.yOri === 0 ? config.hFilter : undefined,
        tickLabelRotation: vizOrientation.xOri === 1 ? xTickLabelRotation * -1 : 0,
        theme,
        grid: { show: customConfig.axisGridShow },
      });
    }
  }

  let stackingGroups = getStackingGroups(frame);

  builder.setStackingGroups(stackingGroups);

  return builder;
};

function shortenValue(value: string, length: number) {
  if (value.length > length) {
    return value.substring(0, length).concat('...');
  } else {
    return value;
  }
}

function getRotationPadding(
  frame: DataFrame,
  rotateLabel: number,
  valueMaxLength: number,
  lftSpace = 0,
  btmSpace = 0
): Padding {
  const values = frame.fields[0].values;
  const fontSize = UPLOT_AXIS_FONT_SIZE;
  const displayProcessor = frame.fields[0].display ?? ((v) => v);
  let maxLength = 0;
  for (let i = 0; i < values.length; i++) {
    let size = measureText(
      shortenValue(formattedValueToString(displayProcessor(values.get(i))), valueMaxLength),
      fontSize
    );
    maxLength = size.width > maxLength ? size.width : maxLength;
  }

  // Add padding to the right if the labels are rotated in a way that makes the last label extend outside the graph.
  const paddingRight =
    rotateLabel > 0
      ? Math.cos((rotateLabel * Math.PI) / 180) *
        measureText(
          shortenValue(formattedValueToString(displayProcessor(values.get(values.length - 1))), valueMaxLength),
          fontSize
        ).width
      : 0;

  // Add padding to the left if the labels are rotated in a way that makes the first label extend outside the graph.
  const paddingLeft =
    rotateLabel < 0
      ? Math.cos((rotateLabel * -1 * Math.PI) / 180) *
        measureText(shortenValue(formattedValueToString(displayProcessor(values.get(0))), valueMaxLength), fontSize)
          .width
      : 0;

  // Add padding to the bottom to avoid clipping the rotated labels.
  const paddingBottom =
    Math.sin(((rotateLabel >= 0 ? rotateLabel : rotateLabel * -1) * Math.PI) / 180) * maxLength - btmSpace;

  return [
    Math.round(UPLOT_AXIS_FONT_SIZE * uPlot.pxRatio),
    paddingRight,
    paddingBottom,
    Math.max(0, paddingLeft - lftSpace),
  ];
}

/** @internal */
export function prepareBarChartDisplayValues(
  series: DataFrame[],
  theme: GrafanaTheme2,
  options: PanelOptions
): BarChartDisplayValues | BarChartDisplayWarning {
  if (!series?.length) {
    return { warn: 'No data in response' };
  }
  let frame = series[0];

  // Convert numeric wide and multi to long
  if (
    !options.xField &&
    series.every((v) => {
      const t = v.meta?.type;
      return t === DataFrameType.NumericWide || t === DataFrameType.NumericMulti;
    })
  ) {
    frame = toNumericLong(series);
    frame.fields.forEach((f) => (f.display = getDisplayProcessor({ field: f, theme })));
  } else {
    // Bar chart requires a single frame
    frame =
      series.length === 1
        ? maybeSortFrame(
            series[0],
            series[0].fields.findIndex((f) => f.type === FieldType.time)
          )
        : outerJoinDataFrames({ frames: series })!;
  }

  if (!frame) {
    return { warn: 'Unable to join data' };
  }

  // Color by a field different than the input
  let colorByField: Field | undefined = undefined;
  if (options.colorByField) {
    colorByField = findField(frame, options.colorByField);
    if (!colorByField) {
      return { warn: 'Color field not found' };
    }
  }

  let configuredXField: Field | undefined = undefined;
  if (options.xField) {
    configuredXField = findField(frame, options.xField);
    if (!configuredXField) {
      return { warn: 'Configured x field not found' };
    }
  }
  let { xField, fields, aligned } = getBarFields(frame, configuredXField, options, theme);
  if (!xField) {
    return {
      warn: 'Bar charts requires a string or time field',
    };
  }

  if (!fields.length) {
    return {
      warn: 'No numeric fields found',
    };
  }

  // Show the first number value
  if (colorByField && fields.length > 1) {
    const firstNumber = fields.find((f) => f !== colorByField);
    if (firstNumber) {
      fields = [firstNumber];
    }
  }

  if (isLegendOrdered(options.legend)) {
    const sortKey = options.legend.sortBy!.toLowerCase();
    const reducers = options.legend.calcs ?? [sortKey];
    fields = orderBy(
      fields,
      (field) => {
        return reduceField({ field, reducers })[sortKey];
      },
      options.legend.sortDesc ? 'desc' : 'asc'
    );
  }

  let legendFields: Field[] = fields;
  if (options.stacking === StackingMode.Percent) {
    legendFields = fields.map((field) => {
      const alignedFrameField = frame.fields.find((f) => f.name === field.name)!;

      const copy = {
        ...field,
        config: {
          ...alignedFrameField.config,
        },
        values: field.values,
      };

      copy.display = getDisplayProcessor({ field: copy, theme });

      return copy;
    });

    legendFields.unshift(xField);
  }

  // String field is first
  fields.unshift(xField);

  return {
    aligned,
    colorByField,
    viz: [
      {
        length: xField.values.length,
        fields: fields, // ideally: fields.filter((f) => !Boolean(f.config.custom?.hideFrom?.viz)),
      },
    ],
    legend: {
      fields: legendFields,
      length: xField.values.length,
    },
  };
}

function getBarFields(
  frame: DataFrame,
  xField: Field | undefined,
  options: PanelOptions,
  theme: GrafanaTheme2
): {
  xField: Field | undefined;
  fields: Field[];
  aligned: DataFrame;
} {
  let stringFields: Field[] | undefined = undefined;
  let timeField: Field | undefined = undefined;
  let fields: Field[] = []; // number fields
  for (const field of frame.fields) {
    if (field === xField) {
      continue;
    }

    switch (field.type) {
      case FieldType.string:
        if (!stringFields) {
          stringFields = [];
        }
        stringFields.push(field);
        break;

      case FieldType.time:
        if (!timeField) {
          timeField = field;
        }
        break;

      case FieldType.number: {
        const copy = {
          ...field,
          state: {
            ...field.state,
            seriesIndex: fields.length, // off by one?
          },
          config: {
            ...field.config,
            custom: {
              ...field.config.custom,
              stacking: {
                group: '_',
                mode: options.stacking,
              },
            },
          },
          values: new ArrayVector(
            field.values.toArray().map((v) => {
              if (!(Number.isFinite(v) || v == null)) {
                return null;
              }
              return v;
            })
          ),
        };

        if (options.stacking === StackingMode.Percent) {
          copy.config.unit = 'percentunit';
          copy.display = getDisplayProcessor({ field: copy, theme });
        }

        fields.push(copy);
      }
    }
  }

  if (!xField) {
    if (stringFields?.length) {
      xField = stringFields[0];

      // When multiple strings exist display them as labels
      if (stringFields?.length > 1) {
        const names = new Array(frame.length);
        for (let i = 0; i < frame.length; i++) {
          const labels: Labels = {};
          for (const f of stringFields) {
            labels[f.name] = f.values.get(i);
          }
          names[i] = formatLabels(labels);
        }
        xField = {
          name: 'Name',
          type: FieldType.string,
          config: {},
          values: new ArrayVector(names),
        };
        xField.display = getDisplayProcessor({ field: xField, theme });
      }
    } else if (timeField) {
      xField = timeField;
    }

    // Try converting to numericWide
    if (!xField && fields.length) {
      frame = toNumericLong([frame]);
      frame.fields.forEach((f) => (f.display = getDisplayProcessor({ field: f, theme })));
      return getBarFields(frame, undefined, options, theme);
    }
  }
  return { xField, fields, aligned: frame };
}

export const isLegendOrdered = (options: VizLegendOptions) => Boolean(options?.sortBy && options.sortDesc !== null);

interface LabelInfo {
  key: string;
  labels: Labels;
  index: number;
}

// This function should eventually live in a transformation
export function toNumericLong(data: DataFrame[]): DataFrame {
  let first: Field | undefined = undefined;
  const uniqueLabels = new Map<string, string[]>();
  const labelInfo = new Map<string, LabelInfo>();
  const labeledNumbers = new Map<string, number[]>();
  for (const frame of data) {
    for (const field of frame.fields) {
      if (field.type === FieldType.number) {
        if (field.labels) {
          if (!first) {
            first = field;
          }
          const key = formatLabels(field.labels);
          let info = labelInfo.get(key);
          if (!info) {
            info = {
              key,
              labels: field.labels,
              index: labelInfo.size,
            };
            labelInfo.set(key, info);

            // Fill in the unique values
            for (const [key, value] of Object.entries(field.labels)) {
              let v = uniqueLabels.get(key);
              if (!v) {
                v = [];
                uniqueLabels.set(key, v);
              }
              v[info.index] = value;
            }
          }
          field.values.toArray().forEach((v, index) => {
            const name = index === 0 ? field.name : `${field.name} (${index + 1})`;
            let values = labeledNumbers.get(name);
            if (!values) {
              values = [];
              labeledNumbers.set(name, values);
            }
            values[info!.index] = v;
          });
        }
      }
    }
  }
  if (labeledNumbers.size) {
    const frame: DataFrame = {
      name: data[0].name,
      refId: data[0].refId,
      meta: {
        ...data[0].meta,
        type: DataFrameType.NumericLong,
      },
      fields: [],
      length: labelInfo.size,
    };
    labeledNumbers.forEach((value, key) => {
      frame.fields.push({
        name: key,
        type: FieldType.number,
        config: first?.config ?? {},
        values: new ArrayVector(value),
      });
    });

    uniqueLabels.forEach((value, key) => {
      frame.fields.push({
        name: key,
        type: FieldType.string,
        config: {},
        values: new ArrayVector(value),
      });
    });
    return frame;
  }

  // Labels were not used, default to simple name+value pair
  const names: string[] = [];
  const values: number[] = [];
  for (const frame of data) {
    for (const field of frame.fields) {
      if (field.type === FieldType.number) {
        if (!first) {
          first = field;
        }
        const name = getFieldDisplayName(field, frame, data);
        field.values.toArray().forEach((v) => {
          names.push(name);
          values.push(v);
        });
      }
    }
  }
  return {
    name: data[0].name,
    refId: data[0].refId,
    meta: {
      ...data[0].meta,
      type: DataFrameType.NumericLong,
    },
    fields: [
      { name: 'Name', type: FieldType.string, values: new ArrayVector(names), config: {} },
      { name: 'Value', type: FieldType.number, values: new ArrayVector(values), config: first?.config ?? {} },
    ],
    length: values.length,
  };
}
